#!/usr/bin/env node
'use strict';

// Operator-run acceptance against the two fixed deployments. Never run this
// automatically in CI, during startup, or as part of a schema migration.
//
// RUN_ONLINE_ACCEPTANCE=1 ACCEPTANCE_RUN_ID=codex_<unique-id>
// ACCEPTANCE_EXPECTED_NODE_COMMIT=<40-character-approved-commit> node ...
// --cleanup resumes cleanup from the durable, private ledger after interruption.
// --self-test performs no network/filesystem writes. --verify-local-cleanup
// permits only isolated loopback MySQL/Redis and never sends HTTP requests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { isDeepStrictEqual } = require('node:util');

const TARGETS = Object.freeze({ yii: 'https://x.b0.01xr.com', node: 'https://x2.b0.01xr.com' });
const MODES = new Set(['run', '--cleanup', '--self-test', '--verify-local-cleanup']);
const ORDER = ['file', 'control', 'setup', 'manager', 'operation', 'device', 'user', 'player', 'shop'];
const FIXED_DATE = '2000-01-01 00:00:00';
class AcceptanceError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new AcceptanceError(code); };
const ident = name => /^[A-Za-z][A-Za-z0-9_]*$/.test(name) ? '`' + name + '`' : fail('invalid-identifier');
const digest = value => crypto.createHash('md5').update(value).digest('hex');
const errorCode = error => error instanceof AcceptanceError ? error.code : /^ER_[A-Z_]+$|^E[A-Z]+$/.test(error?.code || '') ? error.code : 'operation-failed';

function configuration(env, args = []) {
  if (args.length > 1 || args[0] && !MODES.has(args[0])) fail('invalid-mode');
  const mode = args[0] || 'run';
  if (mode === '--self-test') return { mode };
  if (env.RUN_ONLINE_ACCEPTANCE !== '1') fail('explicit-write-opt-in-required');
  const runId = env.ACCEPTANCE_RUN_ID;
  if (typeof runId !== 'string' || !/^codex_[a-z0-9][a-z0-9_]{7,42}$/.test(runId)) fail('invalid-run-id');
  const database = env.MYSQL_DATABASE || 'game';
  const mysql = { host: env.MYSQL_HOST || '127.0.0.1', port: Number(env.MYSQL_PORT || 3306),
    user: env.MYSQL_USER || 'game', password: env.MYSQL_PASSWORD || '', database,
    charset: env.MYSQL_CHARSET || 'utf8mb4', timezone: '+08:00', dateStrings: true,
    decimalNumbers: true, multipleStatements: false, connectTimeout: 5000 };
  const redis = { socket: { host: env.REDIS_HOST || '127.0.0.1', port: Number(env.REDIS_PORT || 6379), connectTimeout: 5000, reconnectStrategy: false },
    database: Number(env.REDIS_DB || 0), password: env.REDIS_PASSWORD || undefined,
    ...(env.REDIS_URL ? { url: env.REDIS_URL } : {}) };
  if (!Number.isInteger(mysql.port) || mysql.port < 1 || mysql.port > 65535 || !/^[a-zA-Z0-9_]+$/.test(database)) fail('invalid-database-settings');
  if (!Number.isInteger(redis.database) || redis.database < 0) fail('invalid-redis-settings');
  if (mode === '--verify-local-cleanup') {
    const local = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
    const redisUrl = redis.url ? new URL(redis.url) : null;
    if (!local(mysql.host) || mysql.port === 3306 || !/^parity_[a-z0-9_]+$/.test(database)
      || !local(redisUrl?.hostname || redis.socket.host) || Number(redisUrl?.port || redis.socket.port) === 6379) fail('local-probe-requires-isolated-services');
  }
  const directory = env.ACCEPTANCE_LEDGER_DIR || '/tmp/codex-online-acceptance';
  if (!path.isAbsolute(directory)) fail('ledger-directory-must-be-absolute');
  const expectedNodeCommit=env.ACCEPTANCE_EXPECTED_NODE_COMMIT;
  if(!/^[a-f0-9]{40}$/.test(expectedNodeCommit||''))fail('expected-node-commit-required');
  let secret;
  try {secret=env.JWT_SECRET?Buffer.from(env.JWT_SECRET):env.JWT_KEY?fs.readFileSync(env.JWT_KEY):null;}catch{fail('ledger-signing-key-unavailable');}
  if(!secret?.length)fail('ledger-signing-key-unavailable');
  const signingKey=crypto.createHmac('sha256',secret).update('codex-online-acceptance-ledger-v1').digest();
  return { mode, runId, mysql, redis, directory, signingKey, expectedNodeCommit, ledgerPath: path.join(directory, runId + '.json') };
}

function fixtureNames(runId) {
  return { playerTel: runId + '_v1_tel', playerOpenId: runId + '_v1_openid', userTel: runId + '_v2_tel',
    openid: runId + '_openid', unionid: runId + '_unionid', shopTag: runId + '_shop',
    uuid: runId + '_device', tag: runId + '_tag', foreignUuid: runId + '_foreign', foreignTag: runId + '_foreign_tag',
    title: runId + '_setup', fileKey: 'codex-acceptance/' + runId + '/read-only.txt', md5: digest(runId + '_file'),
    orderNo: runId.slice(0, 26) + '_dry', v1Token: 'C' + digest(runId + '_v1'), v2Token: 'D' + digest(runId + '_v2') };
}
function dependencies() {
  const app = createRequire(path.resolve(process.cwd(), 'package.json'));
  return { mysql: app('mysql2/promise'), createClient: app('redis').createClient,
    AuthService: app(path.resolve(process.cwd(), 'dist/core/auth.js')).AuthService,
    buildRedisKey: app(path.resolve(process.cwd(), 'dist/core/redis.js')).buildRedisKey };
}
function binding(config) {
  const redisUrl=config.redis.url?new URL(config.redis.url):null;
  return crypto.createHash('sha256').update(JSON.stringify({mysql:[config.mysql.host,config.mysql.port,config.mysql.database],redis:[redisUrl?.hostname||config.redis.socket.host,Number(redisUrl?.port||config.redis.socket.port),redisUrl?.pathname||config.redis.database],commit:config.expectedNodeCommit})).digest('hex');
}
async function deploymentGate(config) {
  const observed={};
  for(const [name,target] of Object.entries(TARGETS)) {
    const response=await fetch(target+'/health',{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json'}});
    const body=await response.json();
    observed[name]={httpStatus:response.status,status:body?.status||null,gitCommit:/^[a-f0-9]{40}$/.test(body?.gitCommit||'')?body.gitCommit:null};
  }
  const code=observed.node.gitCommit!==config.expectedNodeCommit?'candidate-commit-mismatch':Object.values(observed).some(row=>row.httpStatus!==200||row.status!=='healthy')?'deployment-health-gate-failed':null;
  if(code){const error=new AcceptanceError(code);error.observedDeployments=observed;throw error;}
  return observed;
}
async function sql(db, query, values = []) { return (await db.query({ sql: query, timeout: 10000 }, values))[0]; }
async function one(db, query, values = []) { return (await sql(db, query, values))[0] || null; }
async function command(redis, args) { return redis.sendCommand(args.map(String)); }
function persist(config, ledger, first = false) {
  const unsigned={...ledger};delete unsigned.integrity;
  ledger.integrity=crypto.createHmac('sha256',config.signingKey).update(JSON.stringify(unsigned)).digest('hex');
  const body = JSON.stringify(ledger, null, 2) + '\n';
  if (first) {
    fs.mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    const directory=fs.lstatSync(config.directory);
    if(!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o077)!==0||typeof process.getuid==='function'&&directory.uid!==process.getuid())fail('ledger-directory-must-be-private');
    fs.writeFileSync(config.ledgerPath, body, { flag: 'wx', mode: 0o600 });
  } else {
    const temporary=config.ledgerPath+'.'+crypto.randomBytes(8).toString('hex')+'.next';
    fs.writeFileSync(temporary,body,{flag:'wx',mode:0o600});fs.renameSync(temporary,config.ledgerPath);
  }
}

async function assertSchema(db) {
  const required = { player: ['id','tel','openId'], shop: ['id','tag'], operation: ['id','shop_id'],
    device: ['id','uuid','tag','shop_id','version'], manager: ['id','player_id','device_id'],
    user: ['id','unionid','openid','tel','role'], control: ['id','user_id','device_id'],
    setup: ['id','device_id','money','slogans','pictures','thumbs','shots','title','scene_id','updated_at'],
    file: ['id','key','user_id','price','md5'], file_payment_order: ['out_trade_no','file_id','user_id'] };
  for (const [table, names] of Object.entries(required)) {
    const columns = await sql(db, 'SHOW COLUMNS FROM ' + ident(table));
    if (names.some(name => !columns.some(column => column.Field === name))) fail('required-schema-unavailable');
  }
}
function redisRows(n, ids) {
  const time = '1700000000';
  return [
    ['checkin', n.v1Token, { token: n.v1Token, openid: n.playerOpenId, status: 'ready', created_at: time, updated_at: time }],
    ['report', n.v1Token, { token: n.v1Token, device: n.uuid, status: 'ready', data: 'acceptance', created_at: time, updated_at: time }],
    ['recode_file', n.v1Token, { token: n.v1Token, key: n.fileKey, dbid: String(ids.file), created_at: time, updated_at: time }],
    ['report', n.v2Token, { token: n.v2Token, uuid: n.uuid, device_id: String(ids.device), status: 'ready', data: 'acceptance', created_at: time, updated_at: time }],
    ['applet', n.v2Token, { token: n.v2Token, id: n.unionid, user_id: String(ids.user), status: 'ready', created_at: time, updated_at: time }],
    ['recode_file', n.v2Token, { token: n.v2Token, key: n.fileKey, file_id: String(ids.file), created_at: time, updated_at: time }],
  ];
}
async function assertAbsent(db, redis, n, keyBuilder) {
  const probes = [
    ['player','tel',n.playerTel], ['player','openId',n.playerOpenId], ['user','unionid',n.unionid],
    ['user','openid',n.openid], ['user','tel',n.userTel], ['shop','tag',n.shopTag],
    ['device','uuid',n.uuid], ['device','uuid',n.foreignUuid], ['device','tag',n.tag], ['device','tag',n.foreignTag],
    ['file','key',n.fileKey], ['file','md5',n.md5], ['file_payment_order','out_trade_no',n.orderNo],
  ];
  for (const [table, field, value] of probes) if (await one(db, 'SELECT 1 AS found FROM ' + ident(table) + ' WHERE ' + ident(field) + '=? LIMIT 1', [value])) fail('fixture-marker-collision');
  for (const [model, token] of redisRows(n, {})) {
    const pk = keyBuilder(token);
    if (Number(await command(redis, ['EXISTS',model + ':a:' + pk])) || await command(redis,['LPOS',model,pk]) !== null) fail('fixture-redis-collision');
  }
}

async function seed(db, redis, config, ledger, deps) {
  const n = fixtureNames(config.runId), ids = {};
  await assertSchema(db);
  await assertAbsent(db, redis, n, deps.buildRedisKey);
  await db.beginTransaction();
  const insert = async (table, data, marker) => {
    const names = Object.keys(data);
    const result = await sql(db, 'INSERT INTO ' + ident(table) + ' (' + names.map(ident).join(',') + ') VALUES (' + names.map(() => '?').join(',') + ')', Object.values(data));
    const id = Number(result.insertId);
    if (!Number.isSafeInteger(id) || id < 1) fail('invalid-fixture-primary-key');
    ledger.rows.push({ table, id, marker });
    return id;
  };
  try {
    ids.player = await insert('player', { tel:n.playerTel,openId:n.playerOpenId,nickname:config.runId,recharge:100,cost:0,give:0,points:50,times:0,grade:0,created_at:FIXED_DATE,updated_at:FIXED_DATE }, {tel:n.playerTel,openId:n.playerOpenId});
    ids.shop = await insert('shop', {tag:n.shopTag,price:10,rate:80,play_time:60,created_at:FIXED_DATE,updated_at:FIXED_DATE}, {tag:n.shopTag});
    ids.operation = await insert('operation',{shop_id:ids.shop,pool:0,income:0,turnover:0},{shop_id:ids.shop});
    ids.device = await insert('device',{uuid:n.uuid,tag:n.tag,shop_id:ids.shop,version:7,ip:'127.0.0.1',created_at:FIXED_DATE,updated_at:FIXED_DATE},{uuid:n.uuid});
    ids.foreign = await insert('device',{uuid:n.foreignUuid,tag:n.foreignTag,version:7,ip:'127.0.0.1',created_at:FIXED_DATE,updated_at:FIXED_DATE},{uuid:n.foreignUuid});
    ids.manager = await insert('manager',{player_id:ids.player,device_id:ids.device,type:'staff'},{player_id:ids.player,device_id:ids.device});
    ids.user = await insert('user',{unionid:n.unionid,openid:n.openid,tel:n.userTel,nickname:config.runId,role:'manager',created_at:FIXED_DATE,updated_at:FIXED_DATE},{unionid:n.unionid,openid:n.openid,tel:n.userTel});
    ids.control = await insert('control',{user_id:ids.user,device_id:ids.device},{user_id:ids.user,device_id:ids.device});
    ids.setup = await insert('setup',{device_id:ids.device,money:250,title:n.title,scene_id:42,slogans:'["acceptance"]',pictures:'[]',thumbs:'[]',shots:'[1,5]',updated_at:FIXED_DATE},{device_id:ids.device});
    ids.file = await insert('file',{key:n.fileKey,user_id:ids.user,unionid:n.unionid,price:250,unlocked:0,type:'text/plain',md5:n.md5,size:7,bucket:'codex-acceptance-fixture',created_at:FIXED_DATE,title:config.runId},{key:n.fileKey,user_id:ids.user});
    ledger.ids = ids;
    // The ledger is durable before COMMIT; interruption before commit leaves at
    // worst references to rolled-back rows, which cleanup handles idempotently.
    ledger.status = 'sql-prepared'; persist(config, ledger);
    await db.commit(); ledger.status = 'sql-committed'; persist(config, ledger);
  } catch (error) { await db.rollback(); throw error; }
  for (const [model, token, values] of redisRows(n, ids)) {
    const pk = deps.buildRedisKey(token), key = model + ':a:' + pk;
    const entry={ model, pk, key, token, status:'prepared' };
    ledger.redis.push(entry); persist(config, ledger);
    // Atomic collision check and creation. Only the new fixture hash and its
    // own list membership are affected; no counters or diagnostic keys change.
    const result = await command(redis,['EVAL',"if redis.call('EXISTS',KEYS[1])~=0 or redis.call('LPOS',KEYS[2],ARGV[1]) then return 0 end;redis.call('RPUSH',KEYS[2],ARGV[1]);for i=2,#ARGV,2 do redis.call('HSET',KEYS[1],ARGV[i],ARGV[i+1]) end;return 1",2,key,model,pk,...Object.entries(values).flat()]);
    if (Number(result) !== 1) {entry.status='refused';persist(config,ledger);fail('fixture-redis-collision');}
    entry.status='created';persist(config,ledger);
  }
  ledger.status = 'fixtures-ready'; persist(config, ledger);
  return { names:n, ids };
}

async function assertOwned(db, ledger, lock = false) {
  const found=new Map();
  for (const row of ledger.rows) {
    if (!ORDER.includes(row.table) || !Number.isSafeInteger(row.id) || row.id < 1 || !row.marker || !Object.keys(row.marker).length) fail('invalid-ledger-row');
    const current = await one(db, 'SELECT * FROM ' + ident(row.table) + ' WHERE id=?' + (lock ? ' FOR UPDATE' : ''), [row.id]);
    if (!current) continue;
    for (const [key,value] of Object.entries(row.marker)) if (String(current[key]) !== String(value)) fail('fixture-ownership-changed');
    found.set(row.table+':'+row.id,current);
  }
  // Numeric child markers alone cannot prove ownership. Their live parent must
  // also exist and have passed its independent runId string-anchor check above.
  const relations={operation:[['shop_id','shop']],device:[['shop_id','shop']],manager:[['player_id','player'],['device_id','device']],
    control:[['user_id','user'],['device_id','device']],setup:[['device_id','device']],file:[['user_id','user']]};
  for(const row of ledger.rows) {
    const current=found.get(row.table+':'+row.id);if(!current)continue;
    for(const [field,parent] of relations[row.table]||[])if(current[field]!==null&&current[field]!==undefined&&!found.has(parent+':'+current[field]))fail('fixture-parent-anchor-missing');
  }
}
async function resetMutable(db, ledger) {
  await assertOwned(db, ledger);
  const n = fixtureNames(ledger.runId), id = ledger.ids;
  await sql(db,'UPDATE device SET tag=?,version=7,ip=?,updated_at=? WHERE id=? AND uuid=?',[n.tag,'127.0.0.1',FIXED_DATE,id.device,n.uuid]);
  await sql(db,'UPDATE setup SET title=?,slogans=?,money=250,updated_at=? WHERE id=? AND device_id=?',[n.title,'["acceptance"]',FIXED_DATE,id.setup,id.device]);
}
async function snapshot(db, ledger) {
  const id = ledger.ids;
  const device = await one(db,'SELECT id,uuid,tag,version,ip,shop_id,(updated_at<>?) AS timestamp_changed FROM device WHERE id=?',[FIXED_DATE,id.device]);
  const setup = await one(db,'SELECT id,device_id,money,title,scene_id,slogans,pictures,thumbs,shots,(updated_at<>?) AS timestamp_changed FROM setup WHERE id=?',[FIXED_DATE,id.setup]);
  for (const field of ['slogans','pictures','thumbs','shots']) if (typeof setup?.[field] === 'string') { try { setup[field] = JSON.parse(setup[field]); } catch {} }
  return { device,setup,player:await one(db,'SELECT id,points,cost,times FROM player WHERE id=?',[id.player]),
    operation:await one(db,'SELECT id,pool,income,turnover FROM operation WHERE id=?',[id.operation]),
    user:await one(db,'SELECT id,role FROM user WHERE id=?',[id.user]),
    file:await one(db,'SELECT id,user_id,price,unlocked FROM file WHERE id=?',[id.file]) };
}
function plan(f) {
  const { ids:i,names:n } = f;
  return [
    ['health','GET','/health',null,null], ['v1.constant','GET','/v1/common/test',null,null], ['v2.constant','GET','/v2/server/test',null,null],
    ['v1.player','GET','/v1/player/'+i.player,null,'v1-player'], ['v1.device','GET','/v1/device/'+i.device,null,'v1-player'],
    ['v1.shop.operation','GET','/v1/shop/'+i.shop+'?expand=operation',null,'v1-player'],
    ['v1.manager.player-info','GET','/v1/system/player-info?targetId='+i.player,null,'v1-player'],
    ['v1.async-routes','GET','/v1/web/async-routes',null,'v1-player'],
    ['v2.devices.scoped','GET','/v2/devices?sort=id',null,'v2-user'],
    ['v2.devices.manage','GET','/v2/devices/manage?DeviceSearch%5Btag%5D='+encodeURIComponent(n.tag),null,'v2-user'],
    ['v2.device.setup','GET','/v2/devices/'+i.device+'?expand=setup',null,'v2-user'],
    ['v2.setups.scoped','GET','/v2/setups?sort=id',null,'v2-user'], ['v2.setup','GET','/v2/setups/'+i.setup,null,'v2-user'],
    ['v2.files.list','GET','/v2/files/list',null,'v2-user'], ['v2.file','GET','/v2/files/'+i.file,null,'v2-user'],
    ['v2.files.index','GET','/v2/files?sort=id',null,'v2-user'],
    ['v2.device.version','GET','/v2/server/info?uuid='+encodeURIComponent(n.uuid)+'&version=31',null,null],
    ['v2.device.configuration','PATCH','/v2/devices/'+i.device,{tag:n.tag+'_changed'},'v2-user'],
    ['v2.setup.configuration','PATCH','/v2/setups/'+i.setup,{title:n.title+'_changed',slogans:['acceptance','updated']},'v2-user'],
    ['v2.setup.clean-save','PATCH','/v2/setups/'+i.setup,{},'v2-user'],
    ['v1.checkin.status','GET','/v1/checkin/status?token='+n.v1Token,null,null],
    ['v1.local.state','GET','/v1/local/log?token='+n.v1Token,null,null],
    ['v2.server.state','GET','/v2/server/log?token='+n.v2Token,null,null],
    ['v2.device.foreign-denied','GET','/v2/devices/'+i.foreign,null,'v2-user',404],
  ].map(([id,method,url,body,domain,status=200])=>({id,method,url,body,domain,status}));
}
function normalized(value, target) {
  if (typeof value === 'string') return value.replaceAll(target, 'https://REFERENCE');
  if (Array.isArray(value)) return value.map(item=>normalized(item,target));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalized(item,target)]));
}
function differencePaths(a,b,prefix='') {
  if (isDeepStrictEqual(a,b)) return [];
  if (a && b && typeof a==='object' && typeof b==='object' && Array.isArray(a)===Array.isArray(b)) return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(key=>differencePaths(a[key],b[key],prefix+'/'+key.replace(/[^a-zA-Z0-9_.-]/g,'_'))).slice(0,50);
  return [prefix||'/'];
}
async function http(target,test,token,local,signal) {
  if (local) fail('local-probe-http-forbidden');
  const response = await fetch(target + test.url, { method:test.method,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)]),
    headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(test.body===null?{}:{'Content-Type':'application/json'})},
    ...(test.body===null?{}:{body:JSON.stringify(test.body)}) });
  const raw=await response.text();
  let body;try {body=JSON.parse(raw);} catch {body={nonJson:true,title:/<title>(.*?)<\/title>/s.exec(raw)?.[1]||null};}
  if(response.status>=400&&body&&typeof body==='object'&&typeof body.name==='string'&&typeof body.message==='string') {
    body={...body};for(const field of ['file','line','stack-trace','trace','previous'])delete body[field];
    body.message=body.message.replace(/, called in .* on line \d+$/s,'');
  }
  if (test.id==='health') body={status:body.status,checks:Object.fromEntries(Object.entries(body.checks||{}).map(([key,row])=>[key,{status:row.status}]))};
  const headers={};
  for (const name of ['content-type','cache-control','expires','pragma','allow','www-authenticate','x-pagination-total-count','x-pagination-page-count','x-pagination-current-page','x-pagination-per-page','link']) {
    const value=response.headers.get(name);if(value!==null) headers[name]=value.replace(/charset=utf-8/ig,'charset=UTF-8').replace(/;\s*rel="([^"]+)"/g,'; rel=$1');
  }
  return normalized({status:response.status,headers,body},target);
}

async function assertNoForeignReferences(db,ledger) {
  const tables=[...new Set(ledger.rows.map(row=>row.table))];
  if (!tables.length) return;
  const schema=(await one(db,'SELECT DATABASE() AS name')).name;
  const references=await sql(db,'SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,REFERENCED_TABLE_NAME,REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IN ('+tables.map(()=>'?').join(',')+')',tables);
  for (const ref of references) {
    if(ref.TABLE_SCHEMA!==schema)fail('cross-schema-reference-blocks-cleanup');
    if (ref.REFERENCED_COLUMN_NAME!=='id') fail('unsupported-cleanup-reference');
    const allowed=ledger.rows.filter(row=>row.table===ref.TABLE_NAME).map(row=>row.id);
    for (const parent of ledger.rows.filter(row=>row.table===ref.REFERENCED_TABLE_NAME)) {
      const query='SELECT 1 AS found FROM '+ident(ref.TABLE_NAME)+' WHERE '+ident(ref.COLUMN_NAME)+'=?'+(allowed.length?' AND id NOT IN ('+allowed.map(()=>'?').join(',')+')':'')+' LIMIT 1';
      if (await one(db,query,[parent.id,...allowed])) fail('nonfixture-reference-blocks-cleanup');
    }
  }
  if (ledger.ids?.user && await one(db,'SELECT 1 AS found FROM file_payment_order WHERE user_id=? OR file_id=? LIMIT 1',[ledger.ids.user,ledger.ids.file])) fail('payment-reference-blocks-cleanup');
}
async function cleanup(db,redis,config,ledger) {
  const result={sqlRowsRemoved:0,redisHashesRemoved:0,sqlVerified:false,redisVerified:false,autoIncrementReset:false};
  await db.beginTransaction();
  try {
    await assertOwned(db,ledger,true);
    await assertNoForeignReferences(db,ledger);
    for (const table of ORDER) for (const row of ledger.rows.filter(row=>row.table===table)) {
      const clauses=Object.keys(row.marker).map(name=>ident(name)+'=?');
      const removed=await sql(db,'DELETE FROM '+ident(table)+' WHERE id=? AND '+clauses.join(' AND '),[row.id,...Object.values(row.marker)]);
      if (Number(removed.affectedRows)>1) fail('cleanup-row-count-invalid');
      result.sqlRowsRemoved+=Number(removed.affectedRows);
    }
    await db.commit();
  } catch (error) { await db.rollback();throw error; }
  for (const row of ledger.redis) {
    if(row.status==='refused')continue;
    if (!['checkin','report','applet','recode_file'].includes(row.model) || row.key!==row.model+':a:'+row.pk || !/^[a-f0-9]{32}$/.test(row.pk)) fail('invalid-ledger-redis-key');
    // A hash is deleted only while its primary token still belongs to this run.
    const removed=Number(await command(redis,['EVAL',"if redis.call('EXISTS',KEYS[1])==0 then redis.call('LREM',KEYS[2],0,ARGV[1]);return 0 end;if redis.call('HGET',KEYS[1],'token')~=ARGV[2] then return -1 end;redis.call('LREM',KEYS[2],0,ARGV[1]);return redis.call('DEL',KEYS[1])",2,row.key,row.model,row.pk,row.token]));
    if (removed<0) fail('redis-ownership-changed');result.redisHashesRemoved+=removed;
  }
  for (const row of ledger.rows) if (await one(db,'SELECT 1 AS found FROM '+ident(row.table)+' WHERE id=?',[row.id])) fail('cleanup-sql-verification-failed');
  result.sqlVerified=true;
  for (const row of ledger.redis.filter(row=>row.status!=='refused')) if (Number(await command(redis,['EXISTS',row.key])) || await command(redis,['LPOS',row.model,row.pk])!==null) fail('cleanup-redis-verification-failed');
  result.redisVerified=true;ledger.status='cleaned';ledger.cleanup=result;persist(config,ledger);
  return result;
}
function loadLedger(config) {
  const ledger=JSON.parse(fs.readFileSync(config.ledgerPath,'utf8'));
  if (ledger.version!==1 || ledger.runId!==config.runId || !Array.isArray(ledger.rows) || !Array.isArray(ledger.redis)) fail('invalid-ledger');
  const unsigned={...ledger};delete unsigned.integrity;
  const signature=crypto.createHmac('sha256',config.signingKey).update(JSON.stringify(unsigned)).digest('hex');
  if(!/^[a-f0-9]{64}$/.test(ledger.integrity||'')||!crypto.timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(ledger.integrity,'hex')))fail('ledger-integrity-invalid');
  if(ledger.binding!==binding(config))fail('ledger-services-do-not-match');
  if(ledger.expectedNodeCommit!==config.expectedNodeCommit)fail('ledger-commit-does-not-match');
  const expected=fixtureNames(config.runId);
  const i=ledger.ids||{};
  const expectedRows=[['player',i.player,{tel:expected.playerTel,openId:expected.playerOpenId}],['shop',i.shop,{tag:expected.shopTag}],
    ['operation',i.operation,{shop_id:i.shop}],['device',i.device,{uuid:expected.uuid}],['device',i.foreign,{uuid:expected.foreignUuid}],
    ['manager',i.manager,{player_id:i.player,device_id:i.device}],['user',i.user,{unionid:expected.unionid,openid:expected.openid,tel:expected.userTel}],
    ['control',i.control,{user_id:i.user,device_id:i.device}],['setup',i.setup,{device_id:i.device}],['file',i.file,{key:expected.fileKey,user_id:i.user}]];
  if(ledger.rows.length) {
    if(ledger.rows.length!==expectedRows.length||Object.values(i).some(id=>!Number.isSafeInteger(id)||id<1))fail('incomplete-ledger');
    for(const [table,id,marker] of expectedRows)if(ledger.rows.filter(row=>row.table===table&&row.id===id&&isDeepStrictEqual(row.marker,marker)).length!==1)fail('invalid-ledger-marker');
  } else if(ledger.redis.length)fail('incomplete-ledger');
  for (const row of ledger.redis) if (![expected.v1Token,expected.v2Token].includes(row.token) || row.pk!==digest(row.token)) fail('invalid-ledger-token');
  return ledger;
}
function selfTest() {
  assert.throws(()=>configuration({},[]),/explicit-write-opt-in/);
  assert.throws(()=>configuration({RUN_ONLINE_ACCEPTANCE:'1',ACCEPTANCE_RUN_ID:'production'},[]),/invalid-run-id/);
  assert.throws(()=>configuration({RUN_ONLINE_ACCEPTANCE:'1',ACCEPTANCE_RUN_ID:'codex_guard_test',MYSQL_DATABASE:'game'},['--verify-local-cleanup']),/isolated-services/);
  assert.throws(()=>configuration({RUN_ONLINE_ACCEPTANCE:'1',ACCEPTANCE_RUN_ID:'codex_guard_test',MYSQL_HOST:'127.0.0.1',MYSQL_PORT:'33368',MYSQL_DATABASE:'parity_guard',REDIS_URL:'redis:\/\/example.invalid:6379'},['--verify-local-cleanup']),/isolated-services/);
  const f={names:fixtureNames('codex_guard_test'),ids:{player:1,shop:2,device:3,user:4,setup:5,file:6,foreign:7}};
  assert.equal(plan(f).length,24);assert(plan(f).every(test=>!/(wechat|wxpay|scan-login|reset-shop|refresh|helper\/test)/.test(test.url)));
  assert(Object.values(TARGETS).every(url=>new URL(url).protocol==='https:'));
  return {mode:'self-test',passed:6,network:false,writes:false};
}
async function main(env=process.env,args=process.argv.slice(2)) {
  const config=configuration(env,args);if(config.mode==='--self-test')return selfTest();
  const deps=dependencies();
  const observedDeployments=config.mode==='run'?await deploymentGate(config):null;
  let ledger=config.mode==='--cleanup'?loadLedger(config):{version:1,runId:config.runId,binding:binding(config),expectedNodeCommit:config.expectedNodeCommit,observedDeployments,createdAt:new Date().toISOString(),status:'created',rows:[],redis:[]};
  if(config.mode!=='--cleanup')persist(config,ledger,true);
  const summary={mode:config.mode,runId:config.runId,ledger:config.ledgerPath,observedDeployments:ledger.observedDeployments,...ledger.ids?{fixtureIds:{...ledger.ids}}:{},completed:false,results:[],cleanup:null,
    excluded:['real-wechat-login','payments-and-callbacks','COS-and-STS','scan-login','global-diagnostics','existing-business-records','physical-device-operation']};
  let db,redis,fatal;
  const abort=new AbortController(),stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    db=await deps.mysql.createConnection(config.mysql);redis=deps.createClient(config.redis);redis.on('error',()=>{});await redis.connect();
    if(abort.signal.aborted)fail('interrupted');
    if(config.mode==='--cleanup') {summary.completed=true;return summary;}
    const f=await seed(db,redis,config,ledger,deps);
    summary.fixtureIds={...f.ids};
    if(config.mode==='--verify-local-cleanup') {
      let refused=false;try{await assertAbsent(db,redis,f.names,deps.buildRedisKey);}catch(error){refused=errorCode(error)==='fixture-marker-collision';}
      if(!refused)fail('local-collision-probe-failed');
      summary.results.push({id:'local.collision-refused',equal:true});
      let httpRefused=false;try{await http(TARGETS.node,plan(f)[0],null,true,abort.signal);}catch(error){httpRefused=errorCode(error)==='local-probe-http-forbidden';}
      if(!httpRefused)fail('local-http-probe-failed');summary.results.push({id:'local.http-disabled',equal:true});
      const resumed=loadLedger(config);if(!isDeepStrictEqual(resumed.rows,ledger.rows))fail('local-ledger-resume-probe-failed');
      summary.results.push({id:'local.signed-ledger-resumes',equal:true});
      const altered=JSON.parse(JSON.stringify(ledger));altered.rows[0].id++;
      fs.writeFileSync(config.ledgerPath,JSON.stringify(altered),{mode:0o600});
      let tamperedRefused=false;try{loadLedger(config);}catch(error){tamperedRefused=errorCode(error)==='ledger-integrity-invalid';}finally{persist(config,ledger);}
      if(!tamperedRefused)fail('local-ledger-tamper-probe-failed');summary.results.push({id:'local.ledger-id-edit-refused',equal:true});
      fail('local-probe-intentional-failure');
    }
    const auth=new deps.AuthService({});
    const tokens={'v1-player':auth.issue({id:f.ids.player},'v1-player',TARGETS.yii).accessToken,'v2-user':auth.issue({id:f.ids.user},'v2-user',TARGETS.yii).accessToken};
    for (const test of plan(f)) {
      const values={};
      for (const [name,target] of Object.entries(TARGETS)) {
        if(abort.signal.aborted)fail('interrupted');
        await resetMutable(db,ledger);
        const response=await http(target,test,test.domain?tokens[test.domain]:null,false,abort.signal);
        values[name]={response,state:await snapshot(db,ledger)};
      }
      const paths=differencePaths(values.yii,values.node);
      const expected=values.yii.response.status===test.status && values.node.response.status===test.status;
      summary.results.push({id:test.id,statuses:{yii:values.yii.response.status,node:values.node.response.status},equal:expected&&!paths.length,differencePaths:paths,...expected?{}:{expectedStatus:test.status}});
    }
    summary.completed=true;
  } catch(error) {
    if(config.mode==='--verify-local-cleanup'&&errorCode(error)==='local-probe-intentional-failure'){summary.results.push({id:'local.failure-path-reached',equal:true});summary.completed=true;}
    else {fatal=errorCode(error);summary.error=fatal;}
  }
  finally {
    if(db&&redis?.isReady)try {summary.cleanup=await cleanup(db,redis,config,ledger);}catch(error){summary.cleanup={restored:false,error:errorCode(error)};fatal=fatal||'cleanup-incomplete';}
    else if(ledger.rows.length||ledger.redis.length){summary.cleanup={restored:false,error:'services-unavailable-resume-with-cleanup'};fatal=fatal||'cleanup-incomplete';}
    if(redis?.isOpen)try{await redis.quit();}catch{}if(db)try{await db.end();}catch{}
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    summary.passed=summary.results.filter(row=>row.equal).length;summary.total=summary.results.length;
    summary.restored=!!summary.cleanup?.sqlVerified&&!!summary.cleanup?.redisVerified;
    ledger.summary=summary;try{persist(config,ledger);}catch{summary.ledgerPersisted=false;}
    if(fatal||!summary.completed||!summary.restored||summary.results.some(row=>!row.equal))process.exitCode=1;
  }
  return summary;
}

module.exports={configuration,fixtureNames,plan,differencePaths,main};
if(require.main===module)main().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.log(JSON.stringify({completed:false,error:errorCode(error),writesStarted:false,...error.observedDeployments?{observedDeployments:error.observedDeployments}:{}}));process.exitCode=1;});
