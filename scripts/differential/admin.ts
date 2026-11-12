import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildRedisKey } from '../../src/core/redis';
import { Differential, type HttpResult, type Target } from './support';

/** Live Yii/Node comparisons. Only the isolated targets accepted by support.ts are used. */
const h = new Differential();
const fixedTime = '2026-10-01 10:00:00';
const owner = 'a'.repeat(64);
const ownerHeaders = { 'X-Admin-Scan-Owner': owner };

function clean(value: any, key = ''): any {
  if (key === 'accessToken' || key === 'refreshToken') return typeof value === 'string' ? '<redacted>' : value;
  if (key === 'ticketId') return { valid: typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) };
  if (key === 'qrText') return { valid: typeof value === 'string' && /^bujiaban-admin-login:\/\/v1\/[a-f0-9]{32}\?secret=[a-f0-9]{64}&origin=/.test(value) };
  if (['expires', 'refreshExpires', 'expiresAt'].includes(key) && typeof value === 'string') {
    const remaining = Math.round((Date.parse(value) - Date.now()) / 1000);
    const expected = key === 'expires' ? 10800 : key === 'refreshExpires' ? 28800 : 300;
    return { iso: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/.test(value), expectedLifetime: Math.abs(remaining - expected) <= 5 };
  }
  if (key === 'updatedAt' && typeof value === 'string' && value !== fixedTime) return { writeTime: /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) };
  if (Array.isArray(value)) return value.map(item => clean(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, nested]) => [name, clean(nested, name)]));
  return value;
}

async function seed(t: Target): Promise<void> {
  await h.reset(t);
  await h.sql(t, 'INSERT INTO user (id,unionid,openid,tel,nickname,created_at,updated_at,role) VALUES (1,?,?,?,?,?,?,?), (2,?,?,?,?,?,?,?)',
    ['parity-owner', 'parity-owner-openid', '13800138001', 'Owner', fixedTime, fixedTime, 'manager', 'parity-other', 'parity-other-openid', '13800138002', 'Other', fixedTime, fixedTime, 'user']);
  await h.sql(t, 'INSERT INTO player (id,tel,nickname,created_at,updated_at) VALUES (1,?,?,?,?)', ['13900139001', 'Player', fixedTime, fixedTime]);
  await h.sql(t, 'INSERT INTO device (id,uuid,tag,created_at,updated_at,ip,version) VALUES (1,?,?,?,?,?,?), (2,?,?,?,?,?,?)',
    ['parity-device-1', 'Owned device', fixedTime, fixedTime, '192.0.2.1', 1, 'parity-device-2', 'Other device', fixedTime, fixedTime, '192.0.2.2', 2]);
  await h.sql(t, 'INSERT INTO control (user_id,device_id) VALUES (1,1)');
  await h.sql(t, 'INSERT INTO setup (id,device_id,title,scene_id,money,slogans,pictures,thumbs,shots,updated_at) VALUES (1,1,?,3,0,?,?,?,?,?), (2,2,?,4,0,?,?,?,?,?)',
    ['First title', JSON.stringify(['keep', ' keep duplicate ']), JSON.stringify(['https://public.example/one.jpg']), '[]', '[1,5,10,20]', fixedTime,
      'Second title', '["other"]', '[]', '[]', '[1,5,10,20]', fixedTime]);
}

async function login(t: Target): Promise<{ response: HttpResult; access: string; refresh: string }> {
  const response = await h.request(t, 'POST', '/admin-api/login', { username: h.config.adminUsername, password: h.config.adminPassword });
  const access = response.body?.token?.accessToken, refresh = response.body?.token?.refreshToken;
  if (response.status !== 200 || typeof access !== 'string' || typeof refresh !== 'string') throw new Error(`Password login did not return a token pair (${response.status})`);
  return { response, access, refresh };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function manager(t: Target): Promise<{ access: string; create: HttpResult; approve: HttpResult; consume: HttpResult; id: string }> {
  const create = await h.request(t, 'POST', '/admin-api/scan-login/tickets', {}, ownerHeaders);
  if (create.status !== 200) throw new Error(`Scan creation failed (${create.status})`);
  const id = create.body.ticketId;
  const secret = new URL(create.body.qrText).searchParams.get('secret');
  const approve = await h.request(t, 'POST', `/v2/web-login/tickets/${id}/approve`, { secret }, bearer(h.token('v2-user', 1)));
  const consume = await h.request(t, 'POST', `/admin-api/scan-login/tickets/${id}/consume`, {}, ownerHeaders);
  const access = consume.body?.token?.accessToken;
  if (approve.status !== 200 || consume.status !== 200 || typeof access !== 'string') throw new Error(`Scan login failed (approve ${approve.status}, consume ${consume.status})`);
  return { access, create, approve, consume, id };
}

async function setupState(t: Target): Promise<any> {
  const rows = await h.sql(t, 'SELECT device_id,title,scene_id,money,slogans,pictures,thumbs,shots FROM setup ORDER BY id');
  return rows.map((row: any) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (['slogans', 'pictures', 'thumbs', 'shots'].includes(key) && typeof value === 'string') { try { return [key, JSON.parse(value)]; } catch { /* Report malformed persisted JSON without changing it. */ } }
    return [key, value];
  })));
}

async function configurationCase(id: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  await h.record(id, async t => {
    await seed(t);
    const credentials = await login(t);
    const response = await h.request(t, 'PUT', '/admin-api/devices/1/configuration', body, { ...bearer(credentials.access), ...headers });
    return { response: clean(response), persisted: await setupState(t) };
  });
}

async function main(): Promise<void> {
  await h.record('admin.session.anonymous', async t => { await seed(t); return h.request(t, 'GET', '/admin-api/session'); });
  await h.record('admin.devices.anonymous', async t => { await seed(t); return h.request(t, 'GET', '/admin-api/devices'); });
  await h.record('admin.session.invalid-bearer', async t => { await seed(t); return h.request(t, 'GET', '/admin-api/session', undefined, bearer('invalid')); });
  await h.record('admin.login.invalid-types', async t => { await seed(t); return h.request(t, 'POST', '/admin-api/login', { username: [], password: 123 }); });
  await h.record('admin.login.wrong-password', async t => {
    await seed(t);
    const result = await h.request(t, 'POST', '/admin-api/login', { username: h.config.adminUsername, password: 'deliberately-wrong-local-password' });
    await login(t); // A successful local login clears the shared issuer's attempt counter.
    return result;
  });
  await h.record('admin.login.valid-and-session', async t => {
    await seed(t); const credentials = await login(t);
    return { login: clean(credentials.response), session: await h.request(t, 'GET', '/admin-api/session', undefined, bearer(credentials.access)) };
  });
  await h.record('admin.access.cross-implementation', async t => {
    await seed(t); const credentials = await login(t), peer = h.targets.find(other => other.name !== t.name)!;
    return h.request(peer, 'GET', '/admin-api/session', undefined, bearer(credentials.access));
  });
  await h.record('admin.refresh.rotation-and-replay', async t => {
    await seed(t); const credentials = await login(t);
    const refresh = await h.request(t, 'POST', '/admin-api/refresh', { refreshToken: credentials.refresh });
    const replay = await h.request(t, 'POST', '/admin-api/refresh', { refreshToken: credentials.refresh });
    return { refresh: clean(refresh), replay };
  });
  await h.record('admin.logout.revokes-access-and-refresh', async t => {
    await seed(t); const credentials = await login(t);
    const logout = await h.request(t, 'POST', '/admin-api/logout', { refreshToken: credentials.refresh }, bearer(credentials.access));
    return { logout, session: await h.request(t, 'GET', '/admin-api/session', undefined, bearer(credentials.access)), refresh: await h.request(t, 'POST', '/admin-api/refresh', { refreshToken: credentials.refresh }) };
  });
  await h.record('admin.scan.manager-role-and-device-scope', async t => {
    await seed(t); const scan = await manager(t);
    return { create: clean(scan.create), approve: clean(scan.approve), consume: clean(scan.consume), devices: clean(await h.request(t, 'GET', '/admin-api/devices', undefined, bearer(scan.access))) };
  });
  await h.record('admin.scan.manager-unowned-device', async t => {
    await seed(t); const scan = await manager(t);
    return { response: await h.request(t, 'PUT', '/admin-api/devices/2/configuration', { title: 'Unauthorized rename' }, bearer(scan.access)), persisted: await setupState(t) };
  });
  await h.record('admin.scan.manager-delete-forbidden', async t => {
    await seed(t); const scan = await manager(t);
    return { response: await h.request(t, 'DELETE', '/admin-api/devices/1', undefined, bearer(scan.access)), devices: await h.sql(t, 'SELECT id FROM device ORDER BY id') };
  });
  await h.record('admin.devices.normalized-list', async t => { await seed(t); const credentials = await login(t); return clean(await h.request(t, 'GET', '/admin-api/devices', undefined, bearer(credentials.access))); });
  await h.record('admin.devices.oversized-path-id', async t => {
    await seed(t); const credentials = await login(t), id = '9'.repeat(400);
    return { preview: await h.request(t, 'GET', `/admin-api/devices/${id}/image-previews`, undefined, bearer(credentials.access)), configuration: await h.request(t, 'PUT', `/admin-api/devices/${id}/configuration`, { title: 'Missing' }, bearer(credentials.access)), deleted: await h.request(t, 'DELETE', `/admin-api/devices/${id}`, undefined, bearer(credentials.access)) };
  });
  await h.record('admin.configuration.invalid-json-surrogates-and-depth', async t => {
    await seed(t); const credentials = await login(t), headers = bearer(credentials.access);
    const responses = [];
    for (const raw of ['{"title":"\\ud800"}', '{"title":"\\udc00"}', '['.repeat(512) + '0' + ']'.repeat(512)]) responses.push(await h.request(t, 'PUT', '/admin-api/devices/1/configuration', raw, headers));
    return { responses, persisted: await setupState(t) };
  });
  await h.record('admin.devices.php-zero-string-name-fallback', async t => {
    await seed(t); await h.sql(t, 'UPDATE device SET tag=? WHERE id=1', ['0']); await h.sql(t, 'UPDATE setup SET title=? WHERE device_id=1', ['未知']);
    const credentials = await login(t); return clean(await h.request(t, 'GET', '/admin-api/devices', undefined, bearer(credentials.access)));
  });
  await h.record('admin.devices.associative-content-via-v2', async t => {
    await seed(t);
    const updated = await h.request(t, 'PATCH', '/v2/setups/1', '{"slogans":{"first":" hello ","second":"world"},"pictures":{"2":" two ","0":"zero"},"thumbs":{"a":" thumb "}}', bearer(h.token('v2-user', 1)));
    const credentials = await login(t);
    return { updated, response: clean(await h.request(t, 'GET', '/admin-api/devices', undefined, bearer(credentials.access))) };
  });
  await configurationCase('admin.configuration.regular-trim', { title: ' Renamed ', slogans: [' first ', '', 'first'], pictures: [], thumbs: [' https://public.example/thumb.jpg '] });
  await configurationCase('admin.configuration.clear-arrays', { slogans: [], pictures: [], thumbs: [] });
  await h.record('admin.configuration.missing-setup-defaults-with-patch', async t => {
    await seed(t); await h.sql(t, 'DELETE FROM setup WHERE device_id=1'); const credentials = await login(t);
    return { response: clean(await h.request(t, 'PUT', '/admin-api/devices/1/configuration', { title: 'New setup', gameId: 3, slogans: [' one '], pictures: [] }, bearer(credentials.access))), persisted: await setupState(t) };
  });
  await configurationCase('admin.configuration.invalid-game-id', { gameId: '3' });
  await configurationCase('admin.configuration.clean-title-timestamp', { title: 'First title' });
  await configurationCase('admin.configuration.clean-lists-timestamp', { pictures: ['https://public.example/one.jpg'], thumbs: [] });
  await h.record('admin.game.clean-id-timestamp', async t => {
    await seed(t); const credentials = await login(t);
    return { response: clean(await h.request(t, 'PUT', '/admin-api/devices/1/game', { gameId: 3 }, bearer(credentials.access))), persisted: await setupState(t), timestamps: await h.sql(t, 'SELECT id,updated_at FROM setup ORDER BY id') };
  });
  for (const [name, lexeme] of [['float', '3.0'], ['exponent', '3e0'], ['scaled-exponent', '30e-1'], ['rounded-float', '3.0000000000000001']]) {
    await configurationCase(`admin.configuration.raw-game-id-${name}`, `{"gameId":${lexeme},"title":"Rejected rename"}`);
    await h.record(`admin.game.raw-game-id-${name}`, async t => {
      await seed(t); const credentials = await login(t);
      return { response: clean(await h.request(t, 'PUT', '/admin-api/devices/1/game', `{"gameId":${lexeme}}`, bearer(credentials.access))), persisted: await setupState(t) };
    });
  }
  await configurationCase('admin.configuration.unknown-field', { money: 10 });
  await configurationCase('admin.configuration.object-shaped-list', { slogans: {} });
  await configurationCase('admin.configuration.array-body', []);
  await configurationCase('admin.configuration.null-body', null);
  await configurationCase('admin.configuration.nbsp-content', { title: '\u00a0Title\u00a0', slogans: ['\u00a0keep\u00a0', '\u00a0'] });
  await configurationCase('admin.configuration.nul-content', { title: '\u0000Title\u0000', pictures: ['\u0000https://public.example/p.png\u0000', '\u0000'] });
  await configurationCase('admin.configuration.emoji-title', { title: 'Device😀' });
  await configurationCase('admin.configuration.sparse-form-array', 'pictures[0]=a&pictures[2]=b', { 'Content-Type': 'application/x-www-form-urlencoded' });
  await configurationCase('admin.configuration.leading-form-index', 'pictures[1]=x', { 'Content-Type': 'application/x-www-form-urlencoded' });
  await configurationCase('admin.configuration.mixed-form-scalar-array', 'pictures=first&pictures[]=second', { 'Content-Type': 'application/x-www-form-urlencoded' });
  await h.record('admin.image-previews.public-images', async t => { await seed(t); const credentials = await login(t); return h.request(t, 'GET', '/admin-api/devices/1/image-previews', undefined, bearer(credentials.access)); });
  await h.record('admin.image-previews.missing-device', async t => { await seed(t); const credentials = await login(t); return h.request(t, 'GET', '/admin-api/devices/999/image-previews', undefined, bearer(credentials.access)); });
  await h.record('admin.delete.unfinished-record-conflict', async t => {
    await seed(t); const credentials = await login(t);
    await h.sql(t, 'INSERT INTO record (id,player_id,device_id,status,created_at,updated_at,game) VALUES (1,1,1,?,?,?,?)', ['running', fixedTime, fixedTime, '{"keep":"history"}']);
    return { response: await h.request(t, 'DELETE', '/admin-api/devices/1', undefined, bearer(credentials.access)), records: await h.sql(t, 'SELECT id,device_id,status,created_at,updated_at FROM record'), devices: await h.sql(t, 'SELECT id FROM device ORDER BY id') };
  });
  await h.record('admin.delete.finished-record-preserved', async t => {
    await seed(t); const credentials = await login(t);
    await h.sql(t, 'INSERT INTO manager (id,player_id,device_id,type) VALUES (1,1,1,?)', ['staff']);
    await h.sql(t, 'INSERT INTO record (id,player_id,device_id,status,created_at,updated_at,game) VALUES (1,1,1,?,?,?,?)', ['finish', fixedTime, fixedTime, '{"keep":"history"}']);
    return { response: await h.request(t, 'DELETE', '/admin-api/devices/1', undefined, bearer(credentials.access)), records: await h.sql(t, 'SELECT id,device_id,status,created_at,updated_at,game FROM record'), devices: await h.sql(t, 'SELECT id FROM device ORDER BY id'), setups: await h.sql(t, 'SELECT device_id FROM setup ORDER BY id'), controls: await h.sql(t, 'SELECT user_id,device_id FROM control'), managers: await h.sql(t, 'SELECT id FROM manager') };
  });
  await h.record('admin.delete.missing-device', async t => { await seed(t); const credentials = await login(t); return h.request(t, 'DELETE', '/admin-api/devices/999', undefined, bearer(credentials.access)); });
  await h.record('admin.scan.wrong-browser-owner', async t => {
    await seed(t); const created = await h.request(t, 'POST', '/admin-api/scan-login/tickets', {}, ownerHeaders);
    if (created.status !== 200) throw new Error(`Scan creation failed (${created.status})`);
    return h.request(t, 'GET', `/admin-api/scan-login/tickets/${created.body.ticketId}`, undefined, { 'X-Admin-Scan-Owner': 'b'.repeat(64) });
  });
  await h.record('admin.scan.approval-and-consumption-replay', async t => {
    await seed(t); const scan = await manager(t);
    return { approveReplay: await h.request(t, 'POST', `/v2/web-login/tickets/${scan.id}/approve`, { secret: new URL(scan.create.body.qrText).searchParams.get('secret') }, bearer(h.token('v2-user', 1))), consumeReplay: await h.request(t, 'POST', `/admin-api/scan-login/tickets/${scan.id}/consume`, {}, ownerHeaders) };
  });
  await configurationCase('admin.configuration.title-too-long', { title: '名'.repeat(256) });
  await h.record('core.redis.numeric-key-format', async t => {
    const values = ['normal-token', '1e+20', '.5', ' 123 ', '-12', '1.25'];
    if (t.name === 'node') return values.map(value => ({ input: value, key: buildRedisKey(value) }));
    const root = resolve('../game/api');
    const code = `require ${JSON.stringify(root + '/vendor/autoload.php')}; require ${JSON.stringify(root + '/vendor/yiisoft/yii2/Yii.php')}; $out=[]; foreach(json_decode(stream_get_contents(STDIN),true) as $value) $out[]=['input'=>$value,'key'=>yii\\redis\\ActiveRecord::buildKey($value)]; echo json_encode($out);`;
    const result = spawnSync('php', ['-d', 'error_reporting=8191', '-r', code], { input: JSON.stringify(values), encoding: 'utf8' });
    if (result.status !== 0) throw new Error('The isolated PHP Redis key comparison failed');
    return JSON.parse(result.stdout);
  }, 'Pure computation using both actual key builders; no production Redis access.');
  const report = await h.finish('admin');
  console.log(`Admin differential comparison: ${report.matched}/${report.total} matched.`);
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Admin differential runner failed'); process.exitCode = 1; });
