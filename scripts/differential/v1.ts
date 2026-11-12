import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import { Differential, type HttpResult, type Target } from './support';

// These fixtures are destructive only inside support.ts's guarded, isolated
// parity databases. The parent runner executes domain scripts sequentially.
async function main(): Promise<void> {
const h = new Differential();
const fixedDate = '2026-01-02 03:04:05';
const authorization = (domain: 'v1-player' | 'v2-user' = 'v1-player', id = 1) => ({ Authorization: `Bearer ${h.token(domain, id)}` });
const md5 = (value: string) => createHash('md5').update(value).digest('hex');

// Remove only request-time volatility, while preserving attribute presence,
// string/number types, timestamp-expression objects, claims, and token validity.
function stable(value: any, key = ''): any {
  if (Array.isArray(value)) return value.map(item => stable(item));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, stable(item, name)]));
  if (typeof value !== 'string') return value;
  if (key === 'accessToken' || key === 'refreshToken') {
    try {
      // Lcobucci preserves fractional NumericDates. jsonwebtoken's default
      // integer-second clock can incorrectly call a just-issued PHP token
      // "not active" for the remainder of its issuance second.
      const claims = jwt.verify(value, readFileSync(h.config.jwtKey), { algorithms: ['HS256'], clockTimestamp: Date.now() / 1000 }) as jwt.JwtPayload;
      return { valid: true, identityDomain: claims.identityDomain, uid: claims.uid, iss: claims.iss,
        ttl: Number(claims.exp) - Number(claims.iat), notBeforeDelta: Number(claims.nbf) - Number(claims.iat) };
    } catch { return { valid: false }; }
  }
  if (key === 'expires' && /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return '<YYYY/MM/DD HH:mm:ss>';
  if (['created_at', 'updated_at', 'startTime', 'endTime'].includes(key)) {
    if (/^\d{10}$/.test(value) && Math.abs(Number(value) * 1000 - Date.now()) < 300_000) return '<epoch-seconds-string>';
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
      const utc = Date.parse(value.replace(' ', 'T') + 'Z');
      const offsetHours = Math.round((utc - Date.now()) / 3_600_000);
      // Preserve a genuine UTC-versus-Shanghai write difference while removing
      // only seconds of request latency. Fixed fixture timestamps stay intact.
      if ([0, 8].includes(offsetHours) && Math.abs(utc - Date.now() - offsetHours * 3_600_000) < 300_000) return `<SQL-datetime-string;clock+${offsetHours}h>`;
    }
  }
  return value;
}

const response = (value: HttpResult) => stable(value);
async function players(t: Target, includeManager = true) {
  await h.sql(t, 'INSERT INTO player (id,tel,openId,recharge,`give`,cost,points,times,grade,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [1, 'parity-manager', 'parity-open-manager', 100, 0, 0, 100, 0, 0, fixedDate, fixedDate]);
  await h.sql(t, 'INSERT INTO player (id,tel,openId,recharge,`give`,cost,points,times,grade,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [2, 'parity-player', 'parity-open-player', 100, 0, 0, 50, 0, 0, fixedDate, fixedDate]);
  if (includeManager) await h.sql(t, 'INSERT INTO manager (id,player_id,type) VALUES (?,?,?)', [1, 1, 'staff']);
}
async function game(t: Target, withRecord = true, status = 'running') {
  await players(t);
  await h.sql(t, 'INSERT INTO shop (id,tag,price,rate,play_time,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [1, 'parity-shop', 10, 80, 60, fixedDate, fixedDate]);
  await h.sql(t, 'INSERT INTO device (id,uuid,tag,shop_id,version,ip,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', [1, 'parity-game-device', 'parity-device-tag', 1, 1, '127.0.0.1', fixedDate, fixedDate]);
  await h.sql(t, 'INSERT INTO operation (id,shop_id,pool,income,turnover) VALUES (?,?,?,?,?)', [1, 1, 0, 2, 10]);
  if (withRecord) {
    await h.sql(t, 'UPDATE player SET cost=10 WHERE id=2');
    await h.sql(t, 'INSERT INTO record (id,player_id,device_id,status,game,created_at,updated_at) VALUES (?,?,?,?,JSON_OBJECT(\'points\',10,\'secodes\',60),?,?)', [1, 2, 1, status, fixedDate, fixedDate]);
  }
}
async function balances(t: Target) {
  return {
    players: await h.sql(t, 'SELECT id,tel,recharge,`give`,cost,points,times,grade FROM player ORDER BY id'),
    operation: await h.sql(t, 'SELECT id,shop_id,pool,income,turnover FROM operation ORDER BY id'),
    records: await h.sql(t, 'SELECT id,player_id,device_id,status,game FROM record ORDER BY id'),
  };
}
async function state(t: Target, token: string) { return response(await h.request(t, 'GET', '/v1/local/log?token=' + encodeURIComponent(token))); }
async function checkin(t: Target, token: string, openid = 'parity-owner') {
  return response(await h.request(t, 'POST', '/v1/checkin/status-ready', { token, openid }));
}
function signedLocal(body: Record<string, unknown>) {
  const time = '123', parameter = [body.device, body.openid, body.key].find(value => !!value);
  return '/v1/local/refresh?time=' + time + '&hash=' + md5(String(body.token) + time + String(parameter) + 'buj1aban.c0m');
}

await h.record('v1-common-test', async t => {
  await h.reset(t);
  return response(await h.request(t, 'GET', '/v1/common/test'));
});
await h.record('v1-rest-missing-bearer', async t => {
  await h.reset(t);
  return response(await h.request(t, 'GET', '/v1/player'));
});
await h.record('v1-rest-invalid-bearer', async t => {
  await h.reset(t);
  return response(await h.request(t, 'GET', '/v1/device', undefined, { Authorization: 'Bearer invalid-fixture-token' }));
});
await h.record('v1-rest-cross-domain-bearer', async t => {
  await h.reset(t); await players(t);
  return response(await h.request(t, 'GET', '/v1/player', undefined, authorization('v2-user')));
});
await h.record('v1-rest-authenticated-player-fields', async t => {
  await h.reset(t); await players(t);
  return response(await h.request(t, 'GET', '/v1/player/2?fields=id,tel,points&expand=role', undefined, authorization()));
});
await h.record('v1-system-manager-required', async t => {
  await h.reset(t); await players(t);
  return response(await h.request(t, 'GET', '/v1/system/player-info?targetId=1', undefined, authorization('v1-player', 2)));
});
await h.record('v1-system-manager-player-info', async t => {
  await h.reset(t); await players(t);
  return response(await h.request(t, 'GET', '/v1/system/player-info?targetId=2', undefined, authorization()));
});
await h.record('v1-fingerprint-sign-in-known-player', async t => {
  await h.reset(t); await players(t);
  const timestamp = '123', openId = 'parity-open-player';
  return response(await h.request(t, 'POST', '/v1/common/sign-in', { openId, timestamp, fingerprint: md5('geek.v0xe1.pa2ty.c0m' + timestamp + openId) }));
});
await h.record('v1-fingerprint-sign-in-unknown-player', async t => {
  await h.reset(t);
  const timestamp = '123', openId = 'parity-unknown';
  return response(await h.request(t, 'POST', '/v1/common/sign-in', { openId, timestamp, fingerprint: md5('geek.v0xe1.pa2ty.c0m' + timestamp + openId) }));
});
await h.record('v1-fingerprint-sign-up-and-persistence', async t => {
  await h.reset(t);
  const timestamp = '123', openId = 'parity-new-player';
  const result = await h.request(t, 'POST', '/v1/common/sign-up', { openId, timestamp, tel: 'parity-new-tel', fingerprint: md5('geek.v0xe1.pa2ty.c0m' + timestamp + openId) });
  return { response: response(result), players: await h.sql(t, 'SELECT id,tel,openId,recharge,`give`,cost,points,times,grade FROM player ORDER BY id') };
});
await h.record('v1-fingerprint-sign-up-missing-tel', async t => {
  await h.reset(t);
  const timestamp = '123', openId = 'parity-new-player';
  return response(await h.request(t, 'POST', '/v1/common/sign-up', { openId, timestamp, fingerprint: md5('geek.v0xe1.pa2ty.c0m' + timestamp + openId) }));
});
await h.record('v1-refresh-valid-token', async t => {
  await h.reset(t); await players(t);
  return response(await h.request(t, 'POST', '/v1/common/refresh-token', { refreshToken: h.token('v1-player', 2) }));
});
await h.record('v1-refresh-cross-domain-token', async t => {
  await h.reset(t); await players(t);
  return response(await h.request(t, 'POST', '/v1/common/refresh-token', { refreshToken: h.token('v2-user', 2) }));
});
await h.record('v1-player-create-request-types-and-persistence', async t => {
  await h.reset(t); await players(t);
  const result = await h.request(t, 'POST', '/v1/player', { tel: 'created-player', points: '3', info: { preference: 'fixture' } }, authorization());
  return { response: response(result), players: await h.sql(t, 'SELECT id,tel,points,info FROM player ORDER BY id') };
});
for (const [name,tel] of [['nbsp','\u00a0'],['form-feed','\f'],['nul','\0']] as const) {
  await h.record('v1-player-required-php-trim-'+name,async t=>{
    await h.reset(t);await players(t);
    const created=await h.request(t,'POST','/v1/player',{tel},authorization());
    return {response:response(created),players:await h.sql(t,'SELECT id,tel FROM player ORDER BY id')};
  });
}
await h.record('v1-player-update-validates-unchanged-legacy-tel',async t=>{
  await h.reset(t);await players(t);await h.sql(t,'UPDATE player SET tel=? WHERE id=2',['']);
  return {response:response(await h.request(t,'PATCH','/v1/player/2',{nickname:'changed'},authorization())),players:await h.sql(t,'SELECT id,tel,nickname FROM player ORDER BY id')};
});
for (const [name,recharge] of [['terminal-lf','1\n'],['terminal-cr','1\r']] as const) {
  await h.record('v1-player-number-pattern-'+name,async t=>{
    await h.reset(t);await players(t);
    return {response:response(await h.request(t,'PATCH','/v1/player/2',{recharge},authorization())),players:await h.sql(t,'SELECT id,recharge FROM player ORDER BY id')};
  });
}
await h.record('v1-shop-gifts-eager-award-nested-fields',async t=>{
  await h.reset(t);await game(t,false);
  await h.sql(t,'INSERT INTO award (id,shop_id,price,type) VALUES (5,1,100,?)',['s']);
  await h.sql(t,'INSERT INTO gift (id,award_id,uuid,created_at,updated_at) VALUES (6,5,?,?,?)',['gift-award',fixedDate,fixedDate]);
  return {
    nested:response(await h.request(t,'GET','/v1/shop/1?expand=gifts.award&fields=id,gifts.id,gifts.award.id',undefined,authorization())),
    direct:response(await h.request(t,'GET','/v1/gift/6?expand=award&fields=id,award.id',undefined,authorization())),
  };
});
await h.record('v1-shop-operation-lazy-defaults',async t=>{
  await h.reset(t);await game(t,false);
  await h.sql(t,'DELETE FROM operation WHERE shop_id=1');
  const stored=()=>h.sql(t,'SELECT id,shop_id,pool,income,turnover FROM operation WHERE shop_id=1 ORDER BY id');
  const before=await stored();
  const first=response(await h.request(t,'GET','/v1/shop/1?expand=operation',undefined,authorization()));
  const afterFirst=await stored();
  const second=response(await h.request(t,'GET','/v1/shop/1?expand=operation',undefined,authorization()));
  return {before,first,afterFirst,second,afterSecond:await stored()};
});
await h.record('v1-award-update-existing-duplicate-default-pairs',async t=>{
  await h.reset(t);await game(t,false);
  const first=await h.request(t,'POST','/v1/award',{shop_id:1},authorization());
  const second=await h.request(t,'POST','/v1/award',{shop_id:1},authorization());
  return {first:response(first),second:response(second),update:response(await h.request(t,'PATCH','/v1/award/'+first.body.id,{price:200},authorization())),awards:await h.sql(t,'SELECT id,shop_id,type,price FROM award ORDER BY id')};
});
await h.record('v1-player-reject-fractional-points', async t => {
  await h.reset(t); await players(t);
  return { response: response(await h.request(t, 'PATCH', '/v1/player/2', { points: '1.5' }, authorization())), players: await h.sql(t, 'SELECT id,points FROM player ORDER BY id') };
});
await h.record('v1-rest-fields-whitespace', async t => {
  await h.reset(t); await players(t);
  return response(await h.request(t, 'GET', '/v1/player/2?fields=id,%20tel', undefined, authorization()));
}, 'Yii trims comma-separated field names; a Node-only string split may omit the second field.');
await h.record('v1-rest-empty-pagination', async t => {
  await h.reset(t);
  return response(await h.request(t, 'GET', '/v1/game'));
}, 'Compare Link headers as well as an empty JSON collection.');
await h.record('v1-rest-invalid-page-size', async t => {
  await h.reset(t); await players(t);
  return response(await h.request(t, 'GET', '/v1/player?per-page=abc&fields=id', undefined, authorization()));
});
await h.record('v1-rest-populated-pagination', async t => {
  await h.reset(t); await players(t);
  return response(await h.request(t, 'GET', '/v1/player?per-page=1&page=2&sort=-id&fields=id,tel', undefined, authorization()));
});
await h.record('v1-custom-device-fields', async t => {
  await h.reset(t);
  const result = await h.request(t, 'GET', '/v1/game/device?uuid=parity-fields-device&fields=id');
  return { response: response(result), devices: await h.sql(t, 'SELECT id,uuid,version FROM device ORDER BY id') };
}, 'Yii recursively applies REST fields to model objects inside custom response wrappers.');
await h.record('v1-record-nested-fields', async t => {
  await h.reset(t); await game(t);
  return response(await h.request(t, 'GET', '/v1/record/1?expand=device&fields=id,device.id', undefined, authorization()));
});
await h.record('v1-checkin-status-ready-success', async t => {
  await h.reset(t);
  return { response: await checkin(t, 'parity-v1-status-ready'), state: await state(t, 'parity-v1-status-ready') };
});
await h.record('v1-checkin-linked-upload-owner-flow', async t => {
  await h.reset(t); const token = 'parity-v1-owner-flow';
  const ready = await checkin(t, token);
  const upload = response(await h.request(t, 'POST', '/v1/checkin/upload', { token, key: 'fixture-upload.jpg' }));
  const linked = response(await h.request(t, 'POST', '/v1/checkin/status-linked', { token, openid: 'parity-owner' }));
  const wrongOwner = response(await h.request(t, 'POST', '/v1/checkin/status-over', { token, openid: 'other-owner' }));
  const correctOwner = response(await h.request(t, 'POST', '/v1/checkin/status-over', { token, openid: 'parity-owner' }));
  return { ready, upload, linked, wrongOwner, correctOwner, state: await state(t, token) };
});
await h.record('v1-checkin-required-token', async t => {
  await h.reset(t);
  return response(await h.request(t, 'POST', '/v1/checkin/status-ready', { openid: 'parity-owner' }));
});
await h.record('v1-checkin-missing-session', async t => {
  await h.reset(t);
  return response(await h.request(t, 'GET', '/v1/checkin/status?token=parity-v1-missing'));
});
await h.record('v1-checkin-status-fields', async t => {
  await h.reset(t); const token = 'parity-v1-status-fields'; await checkin(t, token);
  return response(await h.request(t, 'GET', '/v1/checkin/status?token=' + token + '&fields=token'));
});
await h.record('v1-checkin-ready-source-property-error', async t => {
  await h.reset(t); const token = 'parity-v1-ready';
  return { response: response(await h.request(t, 'POST', '/v1/checkin/ready', { token, openid: 'parity-owner' })), state: await state(t, token) };
}, 'Yii assigns undeclared Checkin::file. A 500-to-success difference is an explicit source-crash-repair boundary, not proof of identical implementations.');
await h.record('v1-checkin-report-source-property-error', async t => {
  await h.reset(t); const token = 'parity-v1-report';
  return { response: response(await h.request(t, 'POST', '/v1/checkin/report', { token, action: 'start', device: 'fixture-device' })), state: await state(t, token) };
}, 'Yii assigns undeclared Report::action; retain the observable exception as a documented compatibility exception.');
await h.record('v1-checkin-close-and-files', async t => {
  await h.reset(t); const token = 'parity-v1-close'; await checkin(t, token);
  await h.request(t, 'POST', '/v1/checkin/upload', { token, key: 'fixture-file.jpg' });
  return {
    files: response(await h.request(t, 'GET', '/v1/checkin/files?openid=parity-owner')),
    close: response(await h.request(t, 'DELETE', '/v1/checkin/close?openid=parity-owner')),
    state: await state(t, token),
  };
});
await h.record('v1-local-refresh-null-argument-source-error', async t => {
  await h.reset(t); const body = { token: 'A' + 'a'.repeat(32), device: 'AR', status: 'running' };
  return { response: response(await h.request(t, 'POST', signedLocal(body), body)), state: await state(t, body.token) };
}, 'The source getCheckin(string $openid) receives null after the report write, so compare Redis side effects as well as HTTP status.');
await h.record('v1-local-refresh-device-with-empty-unused-strings', async t => {
  await h.reset(t); const body = { token: 'B' + 'b'.repeat(32), device: 'AR', openid: '', key: '', status: 'running', data: 'fixture-data' };
  return { response: response(await h.request(t, 'POST', signedLocal(body), body)), state: await state(t, body.token) };
}, 'Explicit empty strings satisfy the PHP parameter types without violating the exactly-one-nonempty-field rule.');
await h.record('v1-local-refresh-openid-with-empty-unused-strings', async t => {
  await h.reset(t); const body = { token: 'C' + 'c'.repeat(32), device: '', openid: 'parity-owner', key: '', status: 'ready', data: 'fixture-data' };
  return { response: response(await h.request(t, 'POST', signedLocal(body), body)), state: await state(t, body.token) };
});
await h.record('v1-local-refresh-key-source-missing-method', async t => {
  await h.reset(t); const token = 'D' + 'd'.repeat(32); await checkin(t, token);
  const body = { token, device: '', openid: '', key: 'fixture-local-file.jpg' };
  return { response: response(await h.request(t, 'POST', signedLocal(body), body)), state: await state(t, token), files: await h.sql(t, 'SELECT id,`key`,unionid FROM file ORDER BY id') };
}, 'The source calls missing v1 File::Create; Node implements file persistence instead.');
await h.record('v1-local-refresh-invalid-signature', async t => {
  await h.reset(t); const token = 'E' + 'e'.repeat(32);
  return { response: response(await h.request(t, 'POST', '/v1/local/refresh?time=123&hash=invalid', { token, device: 'AR' })), state: await state(t, token) };
});
await h.record('v1-local-log-fields', async t => {
  await h.reset(t); const token = 'parity-v1-log-fields'; await checkin(t, token);
  return response(await h.request(t, 'GET', '/v1/local/log?token=' + token + '&fields=token'));
});
await h.record('v1-redis-numeric-token-normalization', async t => {
  await h.reset(t); const token = '.1', result = await checkin(t, token);
  return { response: result, redisKeys: (await h.redis(t, ['KEYS', 'checkin:a:*'])).sort(), state: await state(t, token) };
}, 'The same logical token must generate the same physical Redis key to share state during a backend switch.');
await h.record('v1-game-finish-integer-points', async t => {
  await h.reset(t); await game(t);
  return { response: response(await h.request(t, 'POST', '/v1/game/finish?uuid=parity-game-device', { points: 3 })), balances: await balances(t) };
});
await h.record('v1-game-finish-ignores-complete-user-validation-failure',async t=>{
  await h.reset(t);await game(t);await h.sql(t,'UPDATE player SET tel=? WHERE id=2',['']);
  return {response:response(await h.request(t,'POST','/v1/game/finish?uuid=parity-game-device',{points:3})),balances:await balances(t)};
});
for (const [name,payload] of [['null',null],['missing-points',{}],['string','hello'],['number',1],['true',true],['false',false],['null-budget',{points:null}],['boolean-budget',{points:true}],['false-budget',{points:false}],['numeric-string-budget',{points:'10'}],['array-budget',{points:[]}],['nonnumeric-budget',{points:'abc'}],['unicode-line-budget',{points:'1\u2028'}]] as const) {
  await h.record('v1-game-finish-stored-game-'+name,async t=>{
    await h.reset(t);await game(t);await h.sql(t,'UPDATE record SET game=? WHERE id=1',[JSON.stringify(payload)]);
    return {response:response(await h.request(t,'POST','/v1/game/finish?uuid=parity-game-device',{points:3})),balances:await balances(t)};
  });
}
for (const [name,points] of [['array',[]],['object',{bad:1}],['nonnumeric','abc']] as const) {
  await h.record('v1-close-record-stored-restore-'+name,async t=>{
    await h.reset(t);await game(t);await h.sql(t,'UPDATE record SET game=? WHERE id=1',[JSON.stringify({points,secodes:60})]);
    return {response:response(await h.request(t,'POST','/v1/system/close-record',{recordId:1},authorization())),balances:await balances(t)};
  });
}
for (const action of ['ready-game','finish','close-record','close-record-history','finish-required-first','finish-budget-first']) {
  await h.record('v1-missing-shop-'+action,async t=>{
    await h.reset(t);await game(t,action!=='ready-game');
    if(action==='close-record-history')await h.sql(t,'UPDATE record SET device_id=NULL WHERE id=1');
    else await h.sql(t,'UPDATE device SET shop_id=NULL WHERE id=1');
    if(action==='finish-required-first'||action==='finish-budget-first')await h.sql(t,'UPDATE record SET game=? WHERE id=1',['{}']);
    const request=action==='ready-game'?h.request(t,'GET','/v1/system/ready-game?targetId=2&deviceId=1',undefined,authorization()):action.startsWith('close-record')?h.request(t,'POST','/v1/system/close-record',{recordId:1},authorization()):h.request(t,'POST','/v1/game/finish?uuid=parity-game-device',action==='finish-required-first'?{}:{points:3});
    return {response:response(await request),balances:await balances(t)};
  });
}
await h.record('v1-game-finish-fractional-points', async t => {
  await h.reset(t); await game(t);
  return { response: response(await h.request(t, 'POST', '/v1/game/finish?uuid=parity-game-device', { points: 1.5 })), balances: await balances(t) };
}, 'Check actual integer-column balances. The PHP save validations reject fractional values but their return values are ignored; Node writes directly.');
for(const [label,points] of [['zero',0],['zero-string','0'],['negative',-1],['above-budget',11],['integer-string','3'],['fraction-string','1.5'],['text','abc'],['null',null],['true',true],['false',false],['empty-list',[]],['list',[1]],['object',{x:1}],['spaced-integer',' 3'],['text-prefix','3abc'],['warning-prefix','0abc']] as const) {
  await h.record('v1-game-finish-json-'+label,async t=>{
    await h.reset(t);await game(t);
    return {response:response(await h.request(t,'POST','/v1/game/finish?uuid=parity-game-device',{points})),balances:await balances(t)};
  },'The unmodified PHP action and its model validators are the input and side-effect oracle.');
}
await h.record('v1-game-start-restart-ready', async t => {
  await h.reset(t); await game(t, true, 'ready');
  return {
    ready: response(await h.request(t, 'GET', '/v1/game/ready?uuid=parity-game-device')),
    start: response(await h.request(t, 'POST', '/v1/game/start?uuid=parity-game-device', {})),
    duplicateStart: response(await h.request(t, 'POST', '/v1/game/start?uuid=parity-game-device', {})),
    restart: response(await h.request(t, 'POST', '/v1/game/restart?uuid=parity-game-device', {})),
    balances: await balances(t),
  };
});
await h.record('v1-system-reserve-deterministic-prize', async t => {
  await h.reset(t); await game(t, false);
  await h.sql(t, 'UPDATE shop SET rate=0 WHERE id=1');
  await h.sql(t, 'UPDATE operation SET pool=0,income=0,turnover=0 WHERE id=1');
  return { response: response(await h.request(t, 'GET', '/v1/system/ready-game?targetId=2&deviceId=1', undefined, authorization())), balances: await balances(t) };
}, 'A zero initial prize pool and zero return rate make both random draws exactly zero, without masking arbitrary payout differences.');
await h.record('v1-system-close-record-refund', async t => {
  await h.reset(t); await game(t, true, 'ready');
  return { response: response(await h.request(t, 'POST', '/v1/system/close-record', { recordId: 1 }, authorization())), balances: await balances(t) };
});
await h.record('v1-system-close-record-rate-changed-fractional-refund', async t => {
  await h.reset(t); await game(t, true, 'ready');
  await h.sql(t, 'UPDATE shop SET rate=75 WHERE id=1');
  await h.sql(t, 'UPDATE record SET game=JSON_OBJECT(\'points\',5,\'secodes\',60) WHERE id=1');
  await h.sql(t, 'UPDATE operation SET pool=0,income=0 WHERE id=1');
  return { response: response(await h.request(t, 'POST', '/v1/system/close-record', { recordId: 1 }, authorization())), balances: await balances(t) };
}, 'A changed shop rate can produce fractional operation balances. Source validation fails before any player/operation write or record deletion.');
await h.record('v1-system-close-record-php-float-validation-and-int-storage', async t => {
  await h.reset(t); await game(t, true, 'ready');
  await h.sql(t, 'UPDATE shop SET price=100,rate=57 WHERE id=1');
  await h.sql(t, 'UPDATE player SET cost=100 WHERE id=2');
  await h.sql(t, 'UPDATE record SET game=JSON_OBJECT(\'points\',28,\'secodes\',60) WHERE id=1');
  await h.sql(t, 'UPDATE operation SET pool=0,income=0,turnover=100 WHERE id=1');
  return { response: response(await h.request(t, 'POST', '/v1/system/close-record', { recordId: 1 }, authorization())), balances: await balances(t) };
}, 'Source percentage arithmetic, PHP float-to-string integer validation, integer SQL storage and the in-memory response are separate parts of the contract.');
await h.record('v1-system-deduct-points', async t => {
  await h.reset(t); await players(t);
  return { response: response(await h.request(t, 'POST', '/v1/system/deduct-points', { targetId: 2, points: 5 }, authorization())), players: await h.sql(t, 'SELECT id,points FROM player ORDER BY id') };
});
for (const [label,points] of [['fraction',1.5],['boolean',true],['numeric-warning','3abc'],['empty-array',[]]] as const) {
  await h.record('v1-system-deduct-points-'+label, async t => {
    await h.reset(t); await players(t);
    return { response: response(await h.request(t, 'POST', '/v1/system/deduct-points', { targetId: 2, points }, authorization())), players: await h.sql(t, 'SELECT id,points FROM player ORDER BY id') };
  });
}
await h.record('v1-system-give-preserves-source-noop', async t => {
  await h.reset(t); await players(t);
  return { response: response(await h.request(t, 'POST', '/v1/system/give', { targetId: 2, money: 10 }, authorization())), players: stable(await h.sql(t, 'SELECT id,recharge,`give`,cost,points,updated_at FROM player ORDER BY id')) };
}, 'The Yii give action validates money but leaves financial balances unchanged.');

const report = await h.finish('v1');
console.log(`v1 differential: ${report.matched}/${report.total} matched; ${report.differences} differences`);
}

void main().catch(() => {
  console.error('v1 differential failed. Check the isolated validation configuration and logs.');
  process.exitCode = 1;
});
