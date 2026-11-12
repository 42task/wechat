import { createHash } from 'node:crypto';
import { Differential, type HttpResult, type Target } from './support';

// Live HTTP comparisons use the helper's separately isolated SQL databases and
// Redis DBs. All users, devices and object keys below are synthetic fixtures.
// These cases stop before any provider transport; the file-report case reuses
// an existing SQL file so neither implementation performs a COS HEAD request.
const h = new Differential();
const before = '2000-01-01 00:00:00';
const recording = `T${'a'.repeat(32)}`;
const expanded = 'token,device,applet,file,setup';
const bearer = (id = 1) => ({ Authorization: `Bearer ${h.token('v2-user', id)}` });

async function seed(t: Target): Promise<void> {
  await h.reset(t);
  await h.sql(t, 'INSERT INTO `user` (id,unionid,openid,tel,nickname,avatar,created_at,updated_at,role) VALUES (?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?)', [
    1, 'parity-union-one', 'parity-open-one', 'fixture-one', 'One', 'one.png', before, before, 'manager',
    2, 'parity-union-two', 'parity-open-two', 'fixture-two', 'Two', 'two.png', before, before, 'manager',
    3, 'parity-union-root', 'parity-open-root', '15000159790', 'Root fixture', null, before, before, 'root',
  ]);
  await h.sql(t, 'INSERT INTO device (id,uuid,tag,version,ip,created_at,updated_at) VALUES (?,?,?,?,?,?,?),(?,?,?,?,?,?,?)', [
    1, 'parity-device-one', 'fixture_1', 7, '127.0.0.1', before, before,
    2, 'parity-device-two', 'fixtureX1', 8, '127.0.0.2', before, before,
  ]);
  await h.sql(t, 'INSERT INTO control (id,user_id,device_id) VALUES (1,1,1),(2,2,2)');
  const insertSetup = 'INSERT INTO setup (id,device_id,money,title,scene_id,slogans,pictures,thumbs,shots,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)';
  for (const id of [1, 2]) await h.sql(t, insertSetup, [id, id, 250, `Setup ${id}`, 42, JSON.stringify(['keep']), JSON.stringify(['https://fixtures.invalid/a.png']), JSON.stringify([]), JSON.stringify([1, 5]), before]);
  await h.sql(t, 'INSERT INTO file (id,`key`,user_id,unionid,price,unlocked,type,md5,size,bucket,created_at,title) VALUES (?,?,?,?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?,?,?,?),(?,?,?,?,?,?,?,?,?,?,?,?)', [
    1, 'parity-owned.mp4', 1, 'parity-union-two', 250, 0, 'video/mp4', 'parity-md5-one', 10, 'fixture-bucket', before, 'Owned',
    2, 'parity-legacy.mp4', null, 'parity-union-one', null, 0, 'video/mp4', 'parity-md5-two', 20, 'fixture-bucket', before, 'Legacy',
    3, 'parity-foreign.mp4', 2, 'parity-union-one', 300, 0, 'video/mp4', 'parity-md5-three', 30, 'fixture-bucket', before, 'Foreign',
    4, 'parity-free.mp4', 1, 'parity-union-one', 0, 0, 'video/mp4', 'parity-md5-four', 40, 'fixture-bucket', before, 'Free',
  ]);
}

async function request(t: Target, method: string, path: string, body?: unknown, headers: Record<string, string> = bearer()): Promise<HttpResult & { method: string; path: string }> {
  const response = await h.request(t, method, path, body, headers);
  // Both forms are equivalent Link parameter tokens. Keep URLs and ordering
  // literal, and preserve missing fields, cache policy and error types as real
  // differences rather than normalizing them away.
  if (response.headers.link) response.headers.link = response.headers.link.replace(/;\s*rel="(self|first|last|prev|next)"/g, '; rel=$1');
  return { method, path, ...response };
}

function signed(value: string): string {
  const time = '1';
  return `time=${time}&hash=${createHash('md5').update(`${recording}${time}${value}buj1aban.c0m`).digest('hex')}`;
}

async function snapshot(t: Target) {
  const devices = await h.sql(t, 'SELECT id,uuid,tag,version,ip,(updated_at <> ?) AS timestamp_changed FROM device ORDER BY id', [before]);
  const setups = await h.sql(t, 'SELECT id,device_id,money,title,scene_id,slogans,pictures,thumbs,shots,(updated_at <> ?) AS timestamp_changed FROM setup ORDER BY id', [before]);
  for (const setup of setups) for (const key of ['slogans', 'pictures', 'thumbs', 'shots']) {
    if (typeof setup[key] === 'string') { try { setup[key] = JSON.parse(setup[key]); } catch { /* Preserve invalid SQL content in the report. */ } }
  }
  return { devices, setups, files: await h.sql(t, 'SELECT id,`key`,user_id,unionid,price,unlocked,created_at FROM file ORDER BY id'), orders: await h.sql(t, 'SELECT out_trade_no,user_id,file_id,amount FROM file_payment_order ORDER BY out_trade_no') };
}

// Only generated Redis epoch fields are normalized, preserving their type and
// range. Seeded SQL dates and any unexpected value remain literal evidence.
function generatedEpochs(value: any): any {
  if(typeof value==='string'&&/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)) {
    const utc=Date.parse(value.replace(' ','T')+'Z');
    if(Math.abs(utc-Date.now())<120000)return '<generated SQL datetime UTC>';
    if(Math.abs(utc-Date.now()-8*3600000)<120000)return '<generated SQL datetime UTC+8>';
  }
  if (Array.isArray(value)) return value.map(generatedEpochs);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    ['created_at', 'updated_at'].includes(key) && typeof item === 'string' && /^\d{10}$/.test(item) && Math.abs(Number(item) - Date.now() / 1000) < 120
      ? '<generated epoch seconds>' : generatedEpochs(item),
  ]));
}

async function simple(id: string, method: string, path: string, body?: unknown, headers?: Record<string, string>, note?: string) {
  await h.record(id, async t => { await seed(t); return { response: await request(t, method, path, body, headers), state: await snapshot(t) }; }, note);
}

async function main(): Promise<void> {
await simple('v2.devices.scoped-index', 'GET', '/v2/devices?sort=id&expand=setup');
await simple('v2.devices.unknown-fields-empty-array', 'GET', '/v2/devices/1?fields=unknown');
await simple('v2.devices.readonly-search-property', 'GET', '/v2/devices/manage?DeviceSearch%5Bsetup%5D=x');
await simple('v2.devices.empty-array-string-validation', 'PATCH', '/v2/devices/1', { uuid: [] });
await simple('v2.setups.large-device-id-string', 'POST', '/v2/setups', { device_id: '9007199254740993' });
await simple('v2.setups.overflow-device-id-string', 'POST', '/v2/setups', { device_id: '9223372036854775808' });
await simple('v2.setups.float-device-id', 'POST', '/v2/setups', '{"device_id":1.0}');
await simple('v2.setups.device-id-trailing-newline', 'POST', '/v2/setups', { device_id: '1\n' });
await simple('v2.devices.manage-literal-filter', 'GET', '/v2/devices/manage?DeviceSearch%5Btag%5D=_&per-page=1&sort=id');
await simple('v2.devices.foreign-detail-denied', 'GET', '/v2/devices/2');
await simple('v2.devices.root-still-control-scoped', 'GET', '/v2/devices', undefined, bearer(3));
await simple('v2.devices.empty-patch-timestamp', 'PATCH', '/v2/devices/1', {}, undefined, 'No-op updates must preserve the old timestamp; SQL side effect compared.');
await simple('v2.devices.same-value-patch-timestamp', 'PATCH', '/v2/devices/1', { tag: 'fixture_1' });
await simple('v2.devices.unsafe-version-ignored', 'PATCH', '/v2/devices/1', { version: 999 });
await simple('v2.devices.duplicate-uuid-validation', 'PATCH', '/v2/devices/1', { uuid: 'parity-device-two' });
await simple('v2.setups.foreign-detail-denied', 'GET', '/v2/setups/2');
await simple('v2.setups.empty-patch-timestamp', 'PATCH', '/v2/setups/1', {});
await simple('v2.setups.same-json-patch-timestamp', 'PATCH', '/v2/setups/1', { slogans: ['keep'] });
await simple('v2.setups.integer-json-versus-float-column', 'PATCH', '/v2/setups/1', { money: 250 });
await simple('v2.setups.php-near-integer-validation-and-storage', 'PATCH', '/v2/setups/1', { scene_id: 28.999999999999993 });
await simple('v2.setups.float-json-versus-float-column', 'PATCH', '/v2/setups/1', '{"money":250.0}');
await simple('v2.setups.php-empty-object-numeric', 'PATCH', '/v2/setups/1', { money: {} });
await h.record('v2.setups.empty-object-is-clean-empty-array',async t=>{
  await seed(t);await h.sql(t,"UPDATE setup SET slogans=JSON_ARRAY() WHERE id=1");
  return {response:await request(t,'PATCH','/v2/setups/1',{slogans:{}}),state:await snapshot(t)};
});
await simple('v2.setups.php-numeric-object-array', 'PATCH', '/v2/setups/1', '{"pictures":{"0":"first","1":"second"}}');
await h.record('v2.setups.php-reversed-numeric-object-roundtrip',async t=>{
  await seed(t);
  const write=await request(t,'PATCH','/v2/setups/1','{"pictures":{"1":"second","0":"first"}}');
  const read=await request(t,'GET','/v2/setups/1');
  if(typeof read.body?.updated_at==='string'&&read.body.updated_at!==before)read.body.updated_at='<changed SQL datetime>';
  return {write,read,state:await snapshot(t)};
});
await h.record('v2.setups.json-scalar-roundtrip', async t => {
  await seed(t);
  const values = { slogans: '备注', pictures: '["literal JSON string"]', thumbs: '123', shots: false };
  const write = await request(t, 'PATCH', '/v2/setups/1', values);
  const read = await request(t, 'GET', '/v2/setups/1');
  // A generated SQL timestamp is compared as a change marker, not wall clock.
  if (read.body && typeof read.body === 'object' && typeof read.body.updated_at === 'string' && read.body.updated_at !== before) read.body.updated_at = '<changed SQL datetime>';
  return { write, read, state: await snapshot(t) };
});
await simple('v2.setups.invalid-numbers-no-side-effects', 'PATCH', '/v2/setups/1', { money: '0x10', scene_id: '1.2', title: false });
await simple('v2.setups.cannot-reassign-device', 'PATCH', '/v2/setups/1', { device_id: 2 });
await simple('v2.setups.cannot-create-for-foreign-device', 'POST', '/v2/setups', { device_id: 2, title: 'forbidden' });
await simple('v2.setups.create-owned-configuration', 'POST', '/v2/setups', { device_id: '1', money: '300', title: 'Additional config', slogans: ['new'] });
await simple('v2.files.list-ignores-forged-unionid', 'GET', '/v2/files/list?unionid=parity-union-two');
await simple('v2.files.pagination-and-price-fields', 'GET', '/v2/files?per-page=1&fields=id,price,unlocked,user_id&sort=-id');
await simple('v2.files.foreign-detail-denied', 'GET', '/v2/files/3');
await h.record('v2.files.untrusted-price-and-unlock-writes-blocked', async t => {
  await seed(t);
  const responses = [];
  for (const [method, path, body] of [['POST', '/v2/files', { key: 'invented.mp4', price: 0, unlocked: 1 }], ['PUT', '/v2/files/1', { unlocked: 1 }], ['PATCH', '/v2/files/1', { price: 0 }], ['DELETE', '/v2/files/1', undefined]] as const) responses.push(await request(t, method, path, body));
  return { responses, state: await snapshot(t) };
});
await simple('v2.payment.unknown-historical-price-rejected', 'POST', '/v2/wechat-pay/wxpay-order', { out_trade_no: 'parityOrder01', file_id: 2 });
await simple('v2.payment.free-file-rejected', 'POST', '/v2/wechat-pay/wxpay-order', { out_trade_no: 'parityOrder01', file_id: 4 });
await simple('v2.payment.client-price-mismatch-rejected', 'POST', '/v2/wechat-pay/wxpay-order', { out_trade_no: 'parityOrder01', file_id: 1, amount: 251 });
await simple('v2.payment.client-payer-mismatch-rejected', 'POST', '/v2/wechat-pay/wxpay-order', { out_trade_no: 'parityOrder01', file_id: 1, openid: 'forged-openid' });
await simple('v2.payment.foreign-file-rejected', 'POST', '/v2/wechat-pay/wxpay-order', { out_trade_no: 'parityOrder01', file_id: 3 });
await simple('v2.server.signed-device-version-sync', 'POST', `/v2/server/device?${signed('parity-device-one')}&expand=token,device,setup`, { token: recording, uuid: 'parity-device-one', version: 27, status: 'ready', data: 'recording fixture' }, {});
await simple('v2.server.invalid-hash-no-side-effects', 'POST', '/v2/server/device?time=1&hash=invalid&expand=token', { token: recording, uuid: 'parity-device-one', version: 27 }, {});
await simple('v2.server.missing-signature-no-side-effects', 'POST', '/v2/server/device?expand=token', { token: recording, uuid: 'parity-device-one', version: 27 }, {});
await simple('v2.server.invalid-version-no-side-effects', 'POST', `/v2/server/device?${signed('parity-device-one')}&expand=token`, { token: recording, uuid: 'parity-device-one', version: '01' }, {});
await simple('v2.server.omitted-version-resets-to-zero', 'POST', `/v2/server/device?${signed('parity-device-one')}&expand=token,device`, { token: recording, uuid: 'parity-device-one' }, {});
await simple('v2.server.info-existing-device-version-sync', 'GET', '/v2/server/info?uuid=parity-device-one&version=29', undefined, {});
await h.record('v2.server.info-new-device-database-clock',async t=>{
  await seed(t);
  return generatedEpochs({response:await request(t,'GET','/v2/server/info?uuid=parity-new-device&version=3',undefined,{}),state:await snapshot(t)});
});
await h.record('v2.server.report-new-device-database-clock',async t=>{
  await seed(t);
  return generatedEpochs({response:await request(t,'POST',`/v2/server/device?${signed('parity-new-device')}&expand=token,device`,{token:recording,uuid:'parity-new-device',version:3},{}),state:await snapshot(t)});
});
await simple('v2.server.info-invalid-version-no-side-effects', 'GET', '/v2/server/info?uuid=parity-device-one&version=-1', undefined, {});
await h.record('v2.recording.report-applet-existing-file-coordination', async t => {
  await seed(t);
  const responses = [
    await request(t, 'POST', `/v2/server/device?${signed('parity-device-one')}&expand=${expanded}`, { token: recording, uuid: 'parity-device-one', version: 7, status: 'ready' }, {}),
    await request(t, 'POST', `/v2/applet/refresh?${signed('parity-union-one')}&expand=${expanded}`, { token: recording, id: 'parity-union-one', status: 'recording', data: '{"slogan":"fixture"}' }),
    await request(t, 'POST', `/v2/server/file?${signed('parity-foreign.mp4')}&expand=${expanded}`, { token: recording, key: 'parity-foreign.mp4' }, {}),
    await request(t, 'GET', `/v2/server/log?token=${recording}`, undefined, {}),
  ];
  const redis: Record<string, unknown> = {};
  const key = createHash('md5').update(recording).digest('hex');
  for (const model of ['report', 'applet', 'recode_file']) {
    const pairs = await h.redis(t, ['HGETALL', `${model}:a:${key}`]) as string[];
    redis[model] = Object.fromEntries(Array.from({ length: pairs.length / 2 }, (_, i) => [pairs[i * 2], pairs[i * 2 + 1]]));
  }
  return generatedEpochs({ responses, redis, state: await snapshot(t) });
}, 'Uses only an existing file key, avoiding COS; compares Redis state and preserves the source protocol that can reassign an existing file owner while retaining price.');
await simple('v2.wechat.login-missing-code-before-provider', 'POST', '/v2/site/login', {}, {});
await simple('v2.wechat.bind-phone-missing-code-before-provider', 'POST', '/v2/wechat/bind-phone', {});

const report = await h.finish('v2');
console.log(JSON.stringify({ suite: 'v2', total: report.total, matched: report.matched, differences: report.differences }));
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
