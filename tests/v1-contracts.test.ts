import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import type { Context, Row, Services } from '../src/core/contracts';
import { parsePhpJson, phpNumberType, setPhpNumberType } from '../src/core/php';
import { markJsonDecoded } from '../src/core/json';

class TestDatabase {
  sqlite = new DatabaseSync(':memory:');
  constructor() {
    this.sqlite.exec(`
      CREATE TABLE player (id INTEGER PRIMARY KEY AUTOINCREMENT, tel TEXT NOT NULL UNIQUE, openId TEXT UNIQUE, nickname TEXT, avatar TEXT, info JSON, recharge REAL DEFAULT 0, cost REAL DEFAULT 0, give REAL DEFAULT 0, points INTEGER DEFAULT 0, times INTEGER DEFAULT 0, grade INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
      CREATE TABLE manager (id INTEGER PRIMARY KEY, player_id INTEGER UNIQUE, type TEXT, device_id INTEGER);
      CREATE TABLE shop (id INTEGER PRIMARY KEY, price INTEGER DEFAULT 10, rate INTEGER DEFAULT 80, play_time INTEGER DEFAULT 60, advanced INTEGER DEFAULT 0, tag TEXT, info JSON, created_at TEXT, updated_at TEXT);
      CREATE TABLE device (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, tag TEXT UNIQUE, shop_id INTEGER, version INTEGER NOT NULL DEFAULT 0, ip TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE operation (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, pool INTEGER DEFAULT 0, income INTEGER DEFAULT 0, turnover INTEGER DEFAULT 0);
      CREATE TABLE record (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL, player_id INTEGER NOT NULL, status TEXT DEFAULT 'ready', game JSON, startTime TEXT, endTime TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE award (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_id INTEGER NOT NULL, type TEXT, price INTEGER DEFAULT 100, UNIQUE(shop_id,type));
      CREATE TABLE gift (id INTEGER PRIMARY KEY AUTOINCREMENT, award_id INTEGER NOT NULL, uuid TEXT UNIQUE, tag TEXT, picture TEXT, info JSON, created_at TEXT, updated_at TEXT);
      CREATE TABLE file (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, unionid TEXT, user_id INTEGER, token TEXT, type TEXT, created_at TEXT, md5 TEXT UNIQUE, unlocked INTEGER DEFAULT 0);
    `);
  }
  async query(sql: string, params: any[] = []): Promise<Row[]> {
    const q = sql.replace(/ FOR UPDATE\b/g, '');
    const statement = this.sqlite.prepare(q);
    if (/^\s*(SELECT|PRAGMA)/i.test(q)) {
      return statement.all(...params).map(raw => {
        const row=Object.fromEntries(Object.entries(raw).map(([k,v]) => [k, ['game','info'].includes(k) && typeof v === 'string' ? parsePhpJson(v) : v]));
        for (const field of ['recharge','cost']) if (typeof row[field] === 'number') setPhpNumberType(row,field,'double');
        return markJsonDecoded(row);
      });
    }
    statement.run(...params); return [];
  }
  async one(sql: string, params: any[] = []) { return (await this.query(sql, params))[0] ?? null; }
  async insert(table: string, data: Row) {
    const keys = Object.keys(data);
    const result = this.sqlite.prepare(`INSERT INTO \`${table}\` (${keys.map(k => '`'+k+'`').join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map(k => typeof data[k] === 'object' && data[k] !== null ? JSON.stringify(data[k]) : data[k]));
    return this.one(`SELECT * FROM \`${table}\` WHERE id = ?`, [Number(result.lastInsertRowid)]);
  }
  async update(table: string, id: any, data: Row) {
    const keys = Object.keys(data);
    if (keys.length) this.sqlite.prepare(`UPDATE \`${table}\` SET ${keys.map(k => '`'+k+'` = ?').join(',')} WHERE id = ?`).run(...keys.map(k => typeof data[k] === 'object' && data[k] !== null ? JSON.stringify(data[k]) : data[k]), id);
    return this.one(`SELECT * FROM \`${table}\` WHERE id = ?`, [id]);
  }
  async delete(table: string, id: any) { this.sqlite.prepare(`DELETE FROM \`${table}\` WHERE id = ?`).run(id); }
  async columns(table: string) { return this.sqlite.prepare(`PRAGMA table_info(\`${table}\`)`).all().map((r: any) => ({ name: r.name, type: r.type, nullable: !r.notnull, default: r.dflt_value, key: r.pk ? 'PRI' : '' })); }
  async transaction<T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> {
    this.sqlite.exec('BEGIN');
    try { const result = await fn(this); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
class TestRedis {
  data = new Map<string, Row>();
  async find(model: string, pk: string) { return structuredClone(this.data.get(model+':'+pk) ?? null); }
  async all(model: string) { return [...this.data.entries()].filter(([k]) => k.startsWith(model+':')).map(([,v]) => structuredClone(v)); }
  async save(model: string, row: Row) { this.data.set(model+':'+row.token, structuredClone(row)); return row; }
  async remove(model: string, pk: string) { this.data.delete(model+':'+pk); }
}

let db: TestDatabase, redis: TestRedis, services: Services, routes: Map<string, (c: Context) => any>, identity: Row;
async function boot() {
  const implementation = await import('../src/v1/index').catch(() => null);
  expect(implementation?.registerV1, 'V1 must register the legacy business routes').toBeTypeOf('function');
  implementation!.registerV1({ add(method: string | string[], path: string, handler: any) { for (const verb of Array.isArray(method) ? method : [method]) routes.set(verb+':'+path, handler); } } as any, services);
}
function context(body: Row = {}, query: Row = {}, params: Row = {}): Context {
  return { body, query, params, req: { ip: '127.0.0.1', method: 'POST', protocol: 'https', headers: {host:'game.test'}, get: () => 'game.test' } as any,
    res: { status() {return this;}, setHeader() {}, header() {}, set() {} } as any };
}
async function call(method: string, path: string, body: Row = {}, query: Row = {}, params: Row = {}) {
  const handler = routes.get(method+':'+path); expect(handler, method+' '+path).toBeTypeOf('function'); return handler!(context(body,query,params));
}
beforeEach(async () => {
  db = new TestDatabase(); redis = new TestRedis(); routes = new Map(); identity = {id:1};
  services = {db,redis,auth:{ bearer: async () => identity, playerFingerprint: () => {}, issue: () => ({accessToken:'signed-access',refreshToken:'signed-refresh'}), refresh: async () => identity, verify: async () => identity }, integrations:{codeSession:async () => ({openid:'verified'})}} as unknown as Services;
  await db.insert('player',{id:1,tel:'manager',recharge:100});
  await db.insert('player',{id:2,tel:'player',recharge:100,points:50});
  await db.insert('manager',{id:1,player_id:1,type:'staff'});
  await db.insert('shop',{id:1,price:10,rate:80,play_time:60});
  await db.insert('device',{id:1,uuid:'device-1',shop_id:1});
  await db.insert('operation',{id:1,shop_id:1,pool:0,income:0,turnover:0});
});

describe('v1 business parity', () => {
  test('registers all real custom endpoints and inherited REST', async () => {
    await boot();
    for (const route of ['GET:/v1/common/test','POST:/v1/common/sign-up','GET:/v1/system/ready-game','POST:/v1/system/close-record','POST:/v1/system/deduct-points','GET:/v1/game/device','POST:/v1/game/finish','GET:/v1/local/log','POST:/v1/local/refresh','POST:/v1/checkin/upload','POST:/v1/checkin/report','GET:/v1/checkin/files','GET:/v1/web/async-routes','GET:/v1/gift','PUT:/v1/shop/:id','GET:/v1/game/:id','GET:/v1/helper/:id']) expect(routes.has(route),route).toBe(true);
  });
  test('game reservation charges once and finishing clamps points to budget', async () => {
    await boot();
    const ready = await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    expect(ready.record.game).toEqual({points:expect.any(Number),secodes:60});
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.cost).toBe(10);
    expect((await db.one('SELECT * FROM operation WHERE id = 1'))!.turnover).toBe(10);
    await expect(call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1})).rejects.toThrow('Already Running');
    await call('POST','/v1/game/start',{}, {uuid:'device-1'});
    const over = await call('POST','/v1/game/finish',{points:999}, {uuid:'device-1'});
    expect(over.player.points).toBe(50+ready.record.game.points);
    expect(over.player.times).toBe(1);
    expect(await db.one('SELECT * FROM record')).toBeNull();
  });
  test('insufficient balance rolls back every reservation mutation', async () => {
    await boot(); await db.update('player',2,{recharge:1});
    await expect(call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1})).rejects.toThrow('Not Enough Money');
    expect((await db.one('SELECT * FROM operation WHERE id = 1'))!.turnover).toBe(0);
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.cost).toBe(0);
    expect(await db.one('SELECT * FROM record')).toBeNull();
  });
  test('closing a reserved game reverses the financial movement', async () => {
    await boot(); const ready = await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    await call('POST','/v1/system/close-record',{recordId:ready.record.id});
    expect(await db.one('SELECT * FROM record')).toBeNull();
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.cost).toBe(0);
    expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id = 1')).toEqual({pool:0,income:0,turnover:0});
  });
  test('closing a game with newly fractional operation balances preserves every row before the source error',async()=>{
    await boot();
    await db.update('shop',1,{rate:75});
    await db.update('player',2,{cost:10,updated_at:'2000-01-01 00:00:00'});
    await db.insert('record',{id:1,device_id:1,player_id:2,status:'ready',game:{points:5,secodes:60}});
    const before={player:await db.one('SELECT * FROM player WHERE id=2'),operation:await db.one('SELECT * FROM operation WHERE id=1'),record:await db.one('SELECT * FROM record WHERE id=1')};
    await expect(call('POST','/v1/system/close-record',{recordId:1})).rejects.toMatchObject({status:500,responseBody:{name:'Exception',message:'json_decode(): Argument #1 ($json) must be of type string, array given',code:0,type:'TypeError'}});
    expect(await db.one('SELECT * FROM player WHERE id=2')).toEqual(before.player);
    expect(await db.one('SELECT * FROM operation WHERE id=1')).toEqual(before.operation);
    expect(await db.one('SELECT * FROM record WHERE id=1')).toEqual(before.record);
  });
  test('57 percent reservation preserves PHP IEEE order, precision validation and integer SQL truncation',async()=>{
    await boot();await db.update('shop',1,{price:100,rate:57});await db.update('player',2,{recharge:200});
    const crypto=createRequire(process.cwd()+'/package.json')('node:crypto');
    const draw=vi.spyOn(crypto,'randomInt').mockReturnValue(28);syncBuiltinESMExports();
    try {
      const response=await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
      expect(draw).toHaveBeenCalledWith(28,57);
      expect(response.record.game.points).toBe(28);
      expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id=1')).toEqual({pool:28,income:43,turnover:100});
      expect(await db.one('SELECT cost FROM player WHERE id=2')).toEqual({cost:100});
    } finally {draw.mockRestore();syncBuiltinESMExports();}
  });
  test('57 percent close returns the original float operation attributes while storing truncated SQL integers',async()=>{
    await boot();await db.update('shop',1,{price:100,rate:57});await db.update('player',2,{cost:100});
    await db.update('operation',1,{pool:0,income:0,turnover:100});
    await db.insert('record',{id:1,device_id:1,player_id:2,status:'ready',game:{points:28,secodes:60}});
    const response=await call('POST','/v1/system/close-record',{recordId:1});
    expect(response.operation).toEqual({pool:-28.999999999999993,income:-43.00000000000001,turnover:0});
    expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id=1')).toEqual({pool:-28,income:-43,turnover:0});
    expect(await db.one('SELECT cost FROM player WHERE id=2')).toEqual({cost:0});
    expect(await db.query('SELECT * FROM record')).toEqual([]);
  });
  test('non-manager cannot deduct another player points', async () => {
    await boot(); identity={id:2};
    await expect(call('POST','/v1/system/deduct-points',{targetId:1,points:10})).rejects.toThrow('Not Manager');
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.points).toBe(50);
  });
  test('checkin state retains uploads and closes only matching owner', async () => {
    await boot();
    await call('POST','/v1/checkin/status-ready',{token:'session',openid:'owner'});
    await call('POST','/v1/checkin/upload',{token:'session',key:'upload.jpg'});
    await call('POST','/v1/checkin/status-linked',{token:'session',openid:'owner'});
    const result = await call('GET','/v1/checkin/status',{}, {token:'session'});
    expect(result.data.checkin.status).toBe('linked'); expect(result.data.file.key).toBe('upload.jpg');
    expect((await call('POST','/v1/checkin/status-over',{token:'session',openid:'intruder'})).success).toBe(false);
    expect((await call('POST','/v1/checkin/status-over',{token:'session',openid:'owner'})).success).toBe(true);
  });
  test('local refresh rejects invalid signature without creating state', async () => {
    await boot();
    await expect(call('POST','/v1/local/refresh',{token:'A'+'a'.repeat(32),device:'AR'},{time:'1',hash:'wrong'})).rejects.toThrow('hash error');
    expect(await redis.all('report')).toEqual([]);
  });
  test('local refresh persists report and reads the corresponding checkin', async () => {
    await boot(); const token='A'+'a'.repeat(32), time='123';
    await redis.save('checkin',{token,openid:'owner',status:'ready'});
    const hash=createHash('md5').update(token+time+'AR'+'buj1aban.c0m').digest('hex');
    const result=await call('POST','/v1/local/refresh',{token,device:'AR',openid:'',key:'',status:'running',data:'{"score":3}'},{time,hash});
    expect(result.data.report).toMatchObject({token,device:'AR',status:'running',data:'{"score":3}'});
    expect(result.data.checkin.openid).toBe('owner');
  });
  test('REST validates foreign keys and supports award filtering and expansions', async () => {
    await boot();
    await expect(call('POST','/v1/award',{shop_id:999})).rejects.toThrow();
    const award=await call('POST','/v1/award',{shop_id:1,type:'small'});
    expect(award.price).toBe(100);
    await call('POST','/v1/gift',{award_id:award.id,uuid:'gift-1'});
    const result=await call('GET','/v1/shop/:id',{}, {expand:'awards,gifts,operation'}, {id:'1'});
    expect(result.awards).toHaveLength(1); expect(result.gifts).toHaveLength(1);
    expect(result.operation).toEqual({pool:0,income:0,turnover:0});
    expect(await call('GET','/v1/award',{}, {shop_id:999})).toEqual([]);
  });
  test('signup stores one player and returns a signed v1 identity', async () => {
    await boot();
    const signed=await call('POST','/v1/common/sign-up',{openId:'new-open',tel:'new-player'});
    expect(signed).toMatchObject({success:true,player:{openId:'new-open',role:'player'},token:{accessToken:'signed-access'}});
    const again=await call('POST','/v1/common/sign-up',{openId:'new-open',tel:'new-player'});
    expect(again.message).toBe('already signup');
    expect(await db.query('SELECT * FROM player WHERE openId = ?', ['new-open'])).toHaveLength(1);
  });
});

describe('v1 REST and failure contracts', () => {
  test('field wildcard preserves default attributes and explicit expansions', async () => {
    await boot();
    const all=await call('GET','/v1/player/:id',{}, {fields:'*',expand:'role'}, {id:'2'});
    expect(all).toMatchObject({id:2,tel:'player',points:50,role:'player'});
    const selected=await call('GET','/v1/player/:id',{}, {fields:'id,tel',expand:'role'}, {id:'2'});
    expect(selected).toEqual({id:2,tel:'player',role:'player'});
  });
  test('REST pagination exposes Yii pagination headers and deterministic requested ordering', async () => {
    await boot();
    const headers:Row={};const ctx=context({}, {'per-page':'1',page:'2',sort:'-id',fields:'id,tel'});
    ctx.res.setHeader=((key:string,value:any)=>{headers[key]=value;return ctx.res;}) as any;
    const response=await routes.get('GET:/v1/player')!(ctx);
    expect(response).toEqual([{id:1,tel:'manager'}]);
    expect(headers).toMatchObject({'X-Pagination-Total-Count':'2','X-Pagination-Page-Count':'2','X-Pagination-Current-Page':'2','X-Pagination-Per-Page':'1'});
    expect(headers.Link).toContain('page=1');
  });
  test('record insertion failure rolls back charged player and operation', async () => {
    await boot();db.sqlite.exec("CREATE TRIGGER reject_record BEFORE INSERT ON record BEGIN SELECT RAISE(FAIL, 'storage rejected'); END;");
    await expect(call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1})).rejects.toThrow('storage rejected');
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.cost).toBe(0);
    expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id = 1')).toEqual({pool:0,income:0,turnover:0});
  });
  test('a second finish cannot award the same budget again', async () => {
    await boot();await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    await call('POST','/v1/game/start',{}, {uuid:'device-1'});
    await call('POST','/v1/game/finish',{points:5},{uuid:'device-1'});
    const first=await db.one('SELECT * FROM player WHERE id = 2');
    await expect(call('POST','/v1/game/finish',{points:5},{uuid:'device-1'})).rejects.toThrow('No record');
    expect(await db.one('SELECT * FROM player WHERE id = 2')).toEqual(first);
  });
  test('legacy give validates money without changing financial balances', async () => {
    await boot();const original=await db.one('SELECT * FROM player WHERE id = 2');
    await call('POST','/v1/system/give',{targetId:2,money:10});
    const saved=await db.one('SELECT * FROM player WHERE id = 2');
    expect(saved!.recharge).toBe(original!.recharge);expect(saved!.give).toBe(original!.give);
  });
  test('REST blocks missing authentication before listing data', async () => {
    await boot();services.auth.bearer=async () => {throw new Error('Unauthorized');};
    await expect(call('GET','/v1/device')).rejects.toThrow('Unauthorized');
  });
  test('duplicate identity and invalid integer updates return validation errors without persistence', async () => {
    await boot();
    await expect(call('POST','/v1/player',{tel:'player'})).rejects.toMatchObject({status:422});
    await expect(call('PATCH','/v1/player/:id',{points:'1.5'}, {}, {id:'2'})).rejects.toMatchObject({status:422});
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.points).toBe(50);
    expect(await db.query('SELECT * FROM player')).toHaveLength(2);
  });
  test('refresh uses only validated v1 refresh token from body and returns legacy token envelope', async () => {
    await boot();let received:any;
    services.auth.refresh=async (...args:any[]) => {received=args;return {accessToken:'new-access',refreshToken:'new-refresh',expires:'2026/10/23 12:00:00'};};
    expect(await call('POST','/v1/common/refresh-token',{refreshToken:'body-refresh'})).toMatchObject({success:true,message:'refresh success',token:{accessToken:'new-access'}});
    expect(received).toEqual(['body-refresh','v1-player','https://game.test']);
  });
  test('local key refresh preserves the source missing File::Create failure without inserting a file', async () => {
    await boot();const token='B'+'b'.repeat(32),time='321',key='new.jpg';
    await redis.save('checkin',{token,openid:'owner',unionid:'union-owner'});
    const hash=createHash('md5').update(token+time+key+'buj1aban.c0m').digest('hex');
    await expect(call('POST','/v1/local/refresh',{token,key,device:'',openid:''},{time,hash})).rejects.toMatchObject({status:500,responseBody:{name:'Exception',message:'Call to undefined method app\\modules\\v1\\models\\File::Create()',code:0,type:'Error'}});
    expect(await redis.find('recode_file',token)).toBeNull();
    expect(await db.query('SELECT * FROM file')).toEqual([]);
  });
  test('game device JSON derives unset unused and running statuses', async () => {
    await boot();
    expect((await call('GET','/v1/game/device',{}, {uuid:'new-device'})).device.status).toBe('unset');
    expect((await call('GET','/v1/device/:id',{}, {}, {id:'1'})).status).toBe('unused');
    await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    await call('POST','/v1/game/start',{}, {uuid:'device-1'});
    const response=await call('GET','/v1/device/:id',{}, {}, {id:'1'});
    expect(response.status).toBe('running');expect(response.created_at).toBeUndefined();
  });
});

 test('new device version initializes to one and client writes cannot change it', async () => {
   await boot();
   const created=await call('POST','/v1/device',{uuid:'versioned',version:99});
   expect(created.version).toBe(1);
   const changed=await call('PATCH','/v1/device/:id',{tag:'new-tag',version:100}, {}, {id:String(created.id)});
   expect(changed.version).toBe(1);
 });

test('v1 Redis responses include only populated attributes and hide v2-only fields', async () => {
  await boot();await redis.save('report',{token:'shared',uuid:'v2-device',device_id:1,status:'running'});
  const response=await call('GET','/v1/local/log',{}, {token:'shared'});
  expect(response.data.report).toEqual({token:'shared',status:'running'});
});

describe('v1 Yii serialization regressions',()=>{
  test('custom system mutations return the saved player model with its SQL timestamp expression',async()=>{
    await boot();const timestamp={expression:'NOW()',params:[]};
    expect((await call('POST','/v1/system/give',{targetId:2,money:10})).player.updated_at).toBeNull();
    expect((await call('POST','/v1/system/deduct-points',{targetId:2,points:1})).player.updated_at).toEqual(timestamp);
    const ready=await call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1});
    expect((await call('POST','/v1/system/close-record',{recordId:ready.record.id})).player.updated_at).toEqual(timestamp);
  });
  test('PHP-empty JSON containers fail required checkin inputs without creating Redis state',async()=>{
    await boot();
    for(const token of [[],{}]) await expect(call('POST','/v1/checkin/status-ready',{token,openid:'owner'})).rejects.toMatchObject({status:400,message:'token is required'});
    expect(await redis.all('checkin')).toEqual([]);
  });
  test('optional numeric empty strings remain strings in the response and persist as null',async()=>{
    await boot();
    expect(await call('PATCH','/v1/player/:id',{recharge:'',points:''},{},{id:'2'})).toMatchObject({recharge:'',points:''});
    expect(await db.one('SELECT recharge,points FROM player WHERE id=2')).toEqual({recharge:null,points:null});
  });
  test('reservation rejects fractional operation balances before charging or creating a record',async()=>{
    await boot();await db.update('shop',1,{rate:75});
    await expect(call('GET','/v1/system/ready-game',{}, {targetId:2,deviceId:1})).rejects.toMatchObject({status:400,message:'Invalid parameters[]'});
    expect((await db.one('SELECT * FROM player WHERE id=2'))!.cost).toBe(0);
    expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id=1')).toEqual({pool:0,income:0,turnover:0});
    expect(await db.one('SELECT * FROM record')).toBeNull();
  });
  test('REST saves serialize the current Yii model attributes without reloading defaults or coercing inputs',async()=>{
    await boot();const timestamp={expression:'NOW()',params:[]};
    expect(await call('POST','/v1/game',{})).toEqual({id:2,version:1,status:'unset'});
    const player=await call('POST','/v1/player',{tel:'fresh',points:'3'});
    expect(player).toEqual({id:3,tel:'fresh',points:'3',created_at:timestamp,updated_at:timestamp});
    expect((await db.one('SELECT * FROM player WHERE id=3'))!.points).toBe(3);
    expect(await call('PATCH','/v1/player/:id',{points:'4'},{},{id:'3'})).toMatchObject({points:'4',updated_at:timestamp});
  });
  test('REST validation preserves Yii labels, first-error ordering, and duplicate values',async()=>{
    await boot();
    await expect(call('POST','/v1/player',{tel:'  '})).rejects.toMatchObject({status:422,response:[{field:'tel',message:'Tel cannot be blank.'}]});
    await expect(call('POST','/v1/player',{tel:'new',recharge:true,points:'1.2',avatar:false})).rejects.toMatchObject({status:422,response:[
      {field:'recharge',message:'Recharge must be a number.'},{field:'points',message:'Points must be an integer.'},{field:'avatar',message:'Avatar must be a string.'}
    ]});
    await expect(call('POST','/v1/player',{tel:'player'})).rejects.toMatchObject({status:422,response:[{field:'tel',message:'Tel "player" has already been taken.'}]});
    await call('POST','/v1/award',{shop_id:1,type:'small'});
    await expect(call('POST','/v1/award',{shop_id:1,type:'small'})).rejects.toMatchObject({status:422,response:[{field:'shop_id',message:'The combination "1"-"small" of Shop ID and Type has already been taken.'}]});
  });
  test('custom signup and game device validation retain the source HTTP 400 envelopes',async()=>{
    await boot();
    await expect(call('POST','/v1/common/sign-up',{tel:' ',openId:'new'})).rejects.toMatchObject({status:400,message:'Invalid parameters{"tel":["Tel cannot be blank."]}'});
    await expect(call('GET','/v1/game/device',{}, {uuid:'x'.repeat(256)})).rejects.toMatchObject({status:400,message:'Invalid device:{"uuid":["Uuid should contain at most 255 characters."]}'});
  });
  test('local log accepts a present empty token and rejects only a missing action parameter',async()=>{
    await boot();
    expect(await call('GET','/v1/local/log',{}, {token:''})).toEqual({success:true,message:'success',data:{checkin:null,report:null,file:null}});
    await expect(call('GET','/v1/local/log')).rejects.toMatchObject({status:400,message:'Missing required parameters: token'});
  });
  test('game device lookup applies the legacy second URL decode before finding or creating a device',async()=>{
    await boot();await db.update('device',1,{uuid:'device 1'});
    expect((await call('GET','/v1/game/device',{}, {uuid:'device+1'})).device.id).toBe(1);
    expect((await call('GET','/v1/game/device',{}, {uuid:'device%201'})).device.id).toBe(1);
    expect(await db.query('SELECT * FROM device')).toHaveLength(1);
    expect((await call('GET','/v1/game/device',{}, {uuid:'device&literal=value'})).device.uuid).toBe('device&literal=value');
  });
  test('numeric balance fields reject JSON booleans and arrays before writing',async()=>{
    await boot();const original=await db.one('SELECT * FROM player WHERE id = 2');
    for (const field of ['recharge','cost','give']) {
      for (const value of [true,false,[100],'0x10',' ','1.']) {
        await expect(call('PATCH','/v1/player/:id',{[field]:value},{},{id:'2'})).rejects.toMatchObject({status:422});
        expect(await db.one('SELECT * FROM player WHERE id = 2')).toEqual(original);
      }
    }
  });
  test('optional numeric fields preserve raw empty array responses and persist zero as Yii does',async()=>{
    await boot();
    expect(await call('PATCH','/v1/player/:id',{recharge:[],cost:[],give:[],points:[],times:[],grade:[]},{},{id:'2'})).toMatchObject({recharge:[],cost:[],give:[],points:[],times:[],grade:[]});
    expect(await db.one('SELECT recharge,cost,give,points,times,grade FROM player WHERE id=2')).toEqual({recharge:0,cost:0,give:0,points:0,times:0,grade:0});
  });
  test('numeric balance fields retain Yii decimal and exponent string support',async()=>{
    await boot();
    expect((await call('PATCH','/v1/player/:id',{recharge:'1.25e2',cost:'.5',give:'-2.5'},{},{id:'2'}))).toMatchObject({recharge:'1.25e2',cost:'.5',give:'-2.5'});
    expect(await db.one('SELECT recharge,cost,give FROM player WHERE id=2')).toEqual({recharge:125,cost:.5,give:-2.5});
  });
  test('integer fields reject numeric JSON arrays instead of coercing them',async()=>{
    await boot();
    await expect(call('PATCH','/v1/player/:id',{points:[100]},{},{id:'2'})).rejects.toMatchObject({status:422});
    expect((await db.one('SELECT * FROM player WHERE id = 2'))!.points).toBe(50);
  });
  test('validation errors and empty inputs skip foreign and unique database lookups',async()=>{
    await boot();
    const original=db.one.bind(db);let unsafeLookup=false;
    db.one=async(sql:string,params:any[]=[])=>{
      if (params.some(value=>typeof value==='boolean' || value!==null && typeof value==='object')) unsafeLookup=true;
      return original(sql,params);
    };
    for (const [table,body] of [['award',{shop_id:[]}],['award',{shop_id:true}],['record',{player_id:2,device_id:[1]}],['player',{tel:{bad:'type'}}]] as const) {
      await expect(call('POST','/v1/'+table,body)).rejects.toMatchObject({status:422});
    }
    expect(unsafeLookup).toBe(false);
    expect(await db.query('SELECT * FROM award')).toEqual([]);
    expect(await db.query('SELECT * FROM record')).toEqual([]);
  });
  test('device version participates in inherited REST sorting and pagination',async()=>{
    await boot();await db.update('device',1,{version:2});
    await db.insert('device',{id:2,uuid:'older',version:1});await db.insert('device',{id:3,uuid:'newer',version:8});
    expect(await call('GET','/v1/device',{}, {sort:'-version','per-page':1,page:2,fields:'id,version'})).toEqual([{id:1,version:2}]);
  });
  test('inherited REST sorting uses only the first valid attribute as Yii does',async()=>{
    await boot();await db.update('device',1,{version:1});await db.insert('device',{id:2,uuid:'second',version:1});
    expect(await call('GET','/v1/device',{}, {sort:'unknown,version,-id',fields:'id'})).toEqual([{id:1},{id:2}]);
  });
  test('award default price applies to explicit null or empty updates',async()=>{
    await boot();const award=await call('POST','/v1/award',{shop_id:1,price:200,type:'s'});
    expect((await call('PATCH','/v1/award/:id',{price:null},{},{id:String(award.id)})).price).toBe(100);
    await call('PATCH','/v1/award/:id',{price:250},{},{id:String(award.id)});
    expect((await call('PATCH','/v1/award/:id',{price:''},{},{id:String(award.id)})).price).toBe(100);
    await call('PATCH','/v1/award/:id',{price:300},{},{id:String(award.id)});
    expect((await call('PATCH','/v1/award/:id',{type:'m'},{},{id:String(award.id)})).price).toBe(300);
  });
  test('award empty array prices receive the default hundred on create and update',async()=>{
    await boot();
    const award=await call('POST','/v1/award',{shop_id:1,price:[],type:'s'});
    expect(award.price).toBe(100);
    await call('PATCH','/v1/award/:id',{price:250},{},{id:String(award.id)});
    expect((await call('PATCH','/v1/award/:id',{price:[]},{},{id:String(award.id)})).price).toBe(100);
  });
  test('record device expansion obeys nested fields without exposing the full row',async()=>{
    await boot();const row=await db.insert('record',{device_id:1,player_id:2,game:{points:1,secodes:60}});
    const selected=await call('GET','/v1/record/:id',{}, {expand:'device',fields:'id,device.id'}, {id:String(row!.id)});
    expect(selected).toEqual({id:row!.id,device:{id:1}});
  });
  test('shop award and gift expansions propagate nested field selections',async()=>{
    await boot();const award=await call('POST','/v1/award',{shop_id:1,type:'s'});
    const gift=await call('POST','/v1/gift',{award_id:award.id,uuid:'nested-gift',tag:'private-tag'});
    const selected=await call('GET','/v1/shop/:id',{}, {expand:'awards,gifts',fields:'id,awards.id,gifts.id'}, {id:'1'});
    expect(selected).toEqual({id:1,awards:[{id:award.id}],gifts:[{id:gift.id}]});
  });
  test('REST creation emits an absolute Location URL with the route identity',async()=>{
    await boot();const headers:Row={},ctx=context({uuid:'absolute-device'});
    ctx.res.setHeader=((key:string,value:any)=>{headers[key]=value;return ctx.res;}) as any;
    const created=await routes.get('POST:/v1/device')!(ctx);
    expect(headers.Location).toBe('https://game.test/v1/device/'+created.id);
  });
});

describe('live Yii differential regressions',()=>{
  test.each([
    ['invalid-fixture-token','The JWT string must have two dots'],
    ['a.b','The JWT string must have two dots'],
    ['.a.b','The JWT string is missing the Header part'],
    ['a..b','The JWT string is missing the Claim part'],
    ['a.b.','The JWT string is missing the Signature part'],
    ['..','The JWT string is missing the Header part'],
  ])('v1 malformed bearer %s retains the source parser exception before authentication',async(token,message)=>{
    await boot();let authenticated=false;const headers:Row={},ctx=context();
    services.auth.bearer=async()=>{authenticated=true;throw new Error('shared-auth-must-not-run');};
    ctx.req.headers.authorization='Bearer '+token;
    ctx.res.setHeader=((name:string,value:any)=>{headers[name]=value;return ctx.res;}) as any;
    await expect(routes.get('GET:/v1/device')!(ctx)).rejects.toMatchObject({status:500,responseBody:{name:'Exception',message,code:0,type:'Lcobucci\\JWT\\Token\\InvalidTokenStructure'}});
    expect(authenticated).toBe(false);expect(headers['WWW-Authenticate']).toBeUndefined();
  });
  test.each([
    ['/v1/system/player-info',{},'targetId'],
    ['/v1/system/reset-shop',{},'shopId'],
    ['/v1/system/ready-game',{},'targetId, deviceId'],
    ['/v1/system/ready-game',{targetId:2},'deviceId'],
    ['/v1/system/ready-game',{deviceId:1},'targetId'],
  ] as const)('action parameter binding for %s precedes body-based lookups',async(path,query,missing)=>{
    await boot();
    await expect(call('GET',path,{targetId:2,deviceId:1,shopId:1},query)).rejects.toMatchObject({status:400,message:'Missing required parameters: '+missing,yiiType:undefined});
    expect(await db.query('SELECT * FROM record')).toEqual([]);
  });
  test('required action parameters are bound after authentication but before manager lookup',async()=>{
    await boot();identity={id:2};
    await expect(call('GET','/v1/system/player-info')).rejects.toMatchObject({status:400,message:'Missing required parameters: targetId'});
    services.auth.bearer=async()=>{throw new Error('auth-first');};
    await expect(call('GET','/v1/system/player-info')).rejects.toThrow('auth-first');
  });
  test.each([undefined,null,false])('close-record missing-like id %s uses PHP empty-string concatenation',async recordId=>{
    await boot();
    await expect(call('POST','/v1/system/close-record',recordId === undefined ? {} : {recordId})).rejects.toMatchObject({status:400,message:'No Record:'});
  });
  test('custom model wrappers apply requested fields while explicit game arrays stay unchanged',async()=>{
    await boot();
    expect((await call('GET','/v1/game/device',{}, {uuid:'device-1',fields:'id'})).device).toEqual({id:1});
    const record=await db.insert('record',{device_id:1,player_id:2,game:{points:10,secodes:60}});
    expect(await call('GET','/v1/game/ready',{}, {uuid:'device-1',fields:'id'})).toEqual({success:true,message:'Ready to play',game:{points:10,secodes:60},record:{id:record!.id}});
    expect((await call('POST','/v1/system/deduct-points',{targetId:2,points:1},{fields:'id, points'})).player).toEqual({id:2,points:49});
  });
  test('give expands only the current User loaded manager relation rather than Player role',async()=>{
    await boot();
    expect(await call('POST','/v1/system/give',{targetId:2,money:1},{fields:'id, manager.id',expand:'manager, role'})).toEqual({success:true,message:'success',user:{id:1,manager:{id:1}},player:{id:2}});
  });
  test('commas trim field and expansion names consistently, including nested selections',async()=>{
    await boot();
    expect(await call('GET','/v1/player/:id',{}, {fields:'id, tel',expand:'unknown, role'}, {id:'2'})).toEqual({id:2,tel:'player',role:'player'});
    const award=await call('POST','/v1/award',{shop_id:1,type:'s'});
    const gift=await call('POST','/v1/gift',{award_id:award.id,uuid:'trimmed-gift'});
    expect(await call('GET','/v1/shop/:id',{}, {expand:'awards, gifts',fields:'id, awards.id, gifts.id'}, {id:'1'})).toEqual({id:1,awards:[{id:award.id}],gifts:[{id:gift.id}]});
  });
  test('Redis model wrappers honor fields and preserve absent versus explicitly null attributes',async()=>{
    await boot();
    await redis.save('checkin',{token:'selected',openid:'owner',status:'ready'});
    await redis.save('report',{token:'selected',device:null,status:'running',uuid:'v2-private'});
    expect((await call('GET','/v1/checkin/status',{}, {token:'selected',fields:'token'})).data).toEqual({checkin:{token:'selected'},report:{token:'selected'},file:null});
    expect((await call('GET','/v1/local/log',{}, {token:'selected'})).data.report).toEqual({token:'selected',device:null,status:'running'});
    expect((await call('GET','/v1/local/log',{}, {token:'selected',fields:'unknown'})).data).toEqual({checkin:[],report:[],file:null});
    expect(await call('GET','/v1/player/:id',{}, {fields:'unknown'}, {id:'2'})).toEqual([]);
  });
  test('empty pagination emits only self and canonicalizes a default page size',async()=>{
    await boot();await db.query('DELETE FROM device');
    const headers:Row={},ctx=context({}, {'per-page':'20'});
    ctx.res.setHeader=((name:string,value:any)=>{headers[name]=value;return ctx.res;}) as any;
    expect(await routes.get('GET:/v1/device')!(ctx)).toEqual([]);
    expect(headers.Link).toBe('<https://game.test/v1/device?page=1>; rel=self');
    expect(headers['X-Pagination-Page-Count']).toBe('0');
  });
  test('pagination follows PHP numeric-prefix casts and rewrites the effective page size in links',async()=>{
    await boot();
    for (const [input,size] of [['abc',1],['2trailing',2],['1e2',50],['-3',1],['.5',1],[[],20]] as const) {
      const headers:Row={},ctx=context({}, {'per-page':input,fields:'id'});
      ctx.res.setHeader=((name:string,value:any)=>{headers[name]=value;return ctx.res;}) as any;
      const rows=await routes.get('GET:/v1/player')!(ctx);
      expect(headers['X-Pagination-Per-Page']).toBe(String(size));
      expect(rows).toHaveLength(Math.min(size,2));
      const self=new URL(/^<([^>]+)>/.exec(headers.Link)![1]);
      expect(self.searchParams.get('per-page')).toBe(size === 20 ? null : String(size));
    }
  });
  test('SQL timestamps use the database clock instead of the application host timezone',async()=>{
    await boot();const one=db.one.bind(db),databaseTime='2020-04-05 06:07:08';
    db.one=async(sql:string,params:any[]=[])=>sql === 'SELECT CURRENT_TIMESTAMP AS currentTimestamp' ? {currentTimestamp:databaseTime} : one(sql,params);
    const player=await call('POST','/v1/player',{tel:'database-time'});
    expect(await db.one('SELECT created_at,updated_at FROM player WHERE id=?',[player.id])).toEqual({created_at:databaseTime,updated_at:databaseTime});
    expect(player.created_at).toEqual({expression:'NOW()',params:[]});
  });
  test('unchanged saves leave the original timestamp and perform no SQL update',async()=>{
    await boot();const original='2020-04-05 06:07:08';await db.update('player',2,{updated_at:original});
    db.sqlite.exec('CREATE TABLE save_audit (id INTEGER); CREATE TRIGGER audit_player_update AFTER UPDATE ON player BEGIN INSERT INTO save_audit VALUES (NEW.id); END;');
    expect((await call('POST','/v1/system/give',{targetId:2,money:10})).player.updated_at).toBe(original);
    expect((await call('PATCH','/v1/player/:id',{points:50},{},{id:'2'})).updated_at).toBe(original);
    expect(await db.query('SELECT * FROM save_audit')).toEqual([]);
    // A string assignment is dirty in Yii even if SQL casts it to the same int.
    expect((await call('PATCH','/v1/player/:id',{points:'50'},{},{id:'2'})).updated_at).toEqual({expression:'NOW()',params:[]});
    expect(await db.query('SELECT * FROM save_audit')).toEqual([{id:2}]);
  });
  test.each([
    {name:'MySQL FLOAT 250 to JSON integer 250',field:'recharge',raw:'250',dirty:true,type:'integer'},
    {name:'MySQL FLOAT 250 to JSON double 250.0',field:'recharge',raw:'250.0',dirty:false,type:'double'},
    {name:'MySQL FLOAT 250 to JSON exponent 2.5e2',field:'recharge',raw:'2.5e2',dirty:false,type:'double'},
    {name:'MySQL integer 250 to JSON double 250.0',field:'points',raw:'250.0',dirty:true,type:'double'},
  ])('$name preserves the PHP oracle dirty decision and request number type through field selection',async({field,raw,dirty,type})=>{
    await boot();const original='2020-04-05 06:07:08';await db.update('player',2,{[field]:250,updated_at:original});
    db.sqlite.exec('CREATE TABLE save_audit (id INTEGER); CREATE TRIGGER audit_player_update AFTER UPDATE ON player BEGIN INSERT INTO save_audit VALUES (NEW.id); END;');
    const body=parsePhpJson(`{"${field}":${raw}}`);
    const response=await call('PATCH','/v1/player/:id',body,{fields:field+',updated_at'},{id:'2'});
    expect(phpNumberType(response,field)).toBe(type);
    expect(response[field]).toBe(250);
    expect(response.updated_at).toEqual(dirty ? {expression:'NOW()',params:[]} : original);
    expect(await db.query('SELECT * FROM save_audit')).toHaveLength(dirty ? 1 : 0);
  });
  test.each([
    {name:'empty stored object to request list',stored:'{}',request:'[]',dirty:false},
    {name:'empty stored list to request object',stored:'[]',request:'{}',dirty:false},
    {name:'reordered string-key object',stored:'{"a":1,"b":2}',request:'{"b":2,"a":1}',dirty:false},
    {name:'nested JSON double to integer',stored:'{"n":250.0}',request:'{"n":250}',dirty:true},
    {name:'nested JSON integer to double',stored:'{"n":250}',request:'{"n":250.0}',dirty:true},
  ])('JSON attribute $name follows actual Yii array comparison',async({stored,request,dirty})=>{
    await boot();const original='2020-04-05 06:07:08';
    db.sqlite.prepare('UPDATE player SET info=?,updated_at=? WHERE id=2').run(stored,original);
    db.sqlite.exec('CREATE TABLE save_audit (id INTEGER); CREATE TRIGGER audit_player_update AFTER UPDATE ON player BEGIN INSERT INTO save_audit VALUES (NEW.id); END;');
    const response=await call('PATCH','/v1/player/:id',parsePhpJson('{"info":'+request+'}'),{fields:'info,updated_at'},{id:'2'});
    expect(response.info).toEqual(parsePhpJson(request));
    expect(response.updated_at).toEqual(dirty ? {expression:'NOW()',params:[]} : original);
    expect(await db.query('SELECT * FROM save_audit')).toHaveLength(dirty ? 1 : 0);
    if (request.includes('250')) expect(phpNumberType(response.info,'n')).toBe(request.includes('.0') ? 'double' : 'integer');
  });
  test('plain JSON fixture empty objects normalize to the same PHP empty array before validation and response',async()=>{
    await boot();
    const created=await call('POST','/v1/player',{tel:'empty-json-object',info:{}});
    expect(created.info).toEqual([]);
    expect((await db.one('SELECT info FROM player WHERE id=?',[created.id]))!.info).toEqual([]);
  });
  test('numeric JSON empty objects follow PHP associative decoding and optional-empty array validation',async()=>{
    await boot();
    expect(await call('PATCH','/v1/player/:id',{recharge:{},cost:{},give:{}},{},{id:'2'})).toMatchObject({recharge:[],cost:[],give:[]});
    expect(await db.one('SELECT recharge,cost,give FROM player WHERE id=2')).toEqual({recharge:0,cost:0,give:0});
  });
  test('fractional game finish reproduces source integer-validation failures without rounding balances',async()=>{
    await boot();await db.insert('record',{device_id:1,player_id:2,status:'running',game:{points:10,secodes:60}});
    const originalPlayer=await db.one('SELECT points,times FROM player WHERE id=2');
    const originalOperation=await db.one('SELECT pool,income,turnover FROM operation WHERE id=1');
    const response=await call('POST','/v1/game/finish',{points:1.5},{uuid:'device-1'});
    expect(response).toMatchObject({success:true,message:'Game over',player:{points:50,times:0}});
    expect(await db.one('SELECT points,times FROM player WHERE id=2')).toEqual(originalPlayer);
    expect(await db.one('SELECT pool,income,turnover FROM operation WHERE id=1')).toEqual(originalOperation);
    expect(await db.query('SELECT * FROM record')).toEqual([]);
  });
  test('a fractional supplied score above an integer budget is clamped before source integer validation',async()=>{
    await boot();await db.insert('record',{device_id:1,player_id:2,status:'running',game:{points:10,secodes:60}});
    expect((await call('POST','/v1/game/finish',{points:11.5},{uuid:'device-1'})).player).toMatchObject({points:60,times:1});
    expect(await db.one('SELECT pool FROM operation WHERE id=1')).toEqual({pool:0});
  });
  test('finish subtracts the point budget before adding to the old pool instead of reassociating floats',async()=>{
    await boot();await db.update('operation',1,{pool:1});
    db.sqlite.prepare('INSERT INTO record (device_id,player_id,status,game) VALUES (1,2,?,?)').run('running','{"points":100000000000000000.0,"secodes":60}');
    const response=await call('POST','/v1/game/finish',parsePhpJson('{"points":100000000000000000.0}'),{uuid:'device-1'});
    expect(response.player).toMatchObject({points:50,times:0});
    expect(await db.one('SELECT pool FROM operation WHERE id=1')).toEqual({pool:1});
    expect(await db.query('SELECT * FROM record')).toEqual([]);
  });
  test('REST integer attributes validate the precision-normalized PHP float but truncate the unrounded value in SQL',async()=>{
    await boot();const body=parsePhpJson('{"points":28.999999999999993}');
    const response=await call('PATCH','/v1/player/:id',body,{}, {id:'2'});
    expect(response.points).toBe(28.999999999999993);
    expect(await db.one('SELECT points FROM player WHERE id=2')).toEqual({points:28});
  });
  test.each([
    {input:0,status:400,message:'No Points',points:50},
    {input:'0',status:400,message:'No Points',points:50},
    {input:null,status:400,message:'No Points',points:50},
    {input:false,status:400,message:'No Points',points:50},
    {input:1.5,status:500,message:'json_decode(): Argument #1 ($json) must be of type string, array given',points:50},
    {input:true,status:200,points:49},
    {input:'0abc',status:500,message:'A non-numeric value encountered',points:50},
    {input:'3',status:200,points:47},
    {input:'3abc',status:500,message:'A non-numeric value encountered',points:50},
    {input:'abc',status:400,message:'Not Enough Points',points:50},
    {input:-1,status:200,points:51},
  ])('deduct points $input follows PHP comparison, arithmetic and integer validation',async({input,status,message,points})=>{
    await boot();
    if(status === 200) expect((await call('POST','/v1/system/deduct-points',{targetId:2,points:input})).player.points).toBe(points);
    else await expect(call('POST','/v1/system/deduct-points',{targetId:2,points:input})).rejects.toMatchObject({status,message});
    expect(await db.one('SELECT points FROM player WHERE id=2')).toEqual({points});
  });
  test.each([
    {name:'number zero',input:0,status:400,points:50,times:0,pool:0},
    {name:'string zero',input:'0',status:400,points:50,times:0,pool:0},
    {name:'negative integer',input:-1,status:200,points:50,times:1,pool:10},
    {name:'above budget',input:11,status:200,points:60,times:1,pool:0},
    {name:'numeric string',input:'3',status:200,points:53,times:1,pool:7},
    {name:'fractional string',input:'1.5',status:200,points:50,times:0,pool:0},
    {name:'nonnumeric string',input:'abc',status:200,points:60,times:1,pool:0},
    {name:'null',input:null,status:400,points:50,times:0,pool:0},
    {name:'true',input:true,status:200,points:51,times:1,pool:9},
    {name:'false',input:false,status:400,points:50,times:0,pool:0},
    {name:'empty array',input:[],status:400,points:50,times:0,pool:0},
    {name:'nonempty array',input:[1],status:200,points:60,times:1,pool:0},
    {name:'JSON object decoded as PHP associative array',input:{x:1},status:200,points:60,times:1,pool:0},
    {name:'leading whitespace',input:' 3',status:200,points:53,times:1,pool:7},
    {name:'numeric prefix with suffix',input:'3abc',status:200,points:60,times:1,pool:0},
  ])('finish JSON boundary: $name matches the PHP 8 oracle',async({input,status,points,times,pool})=>{
    await boot();await db.insert('record',{device_id:1,player_id:2,status:'running',game:{points:10,secodes:60}});
    if (status === 400) await expect(call('POST','/v1/game/finish',{points:input},{uuid:'device-1'})).rejects.toMatchObject({status:400,message:'points is required'});
    else expect((await call('POST','/v1/game/finish',{points:input},{uuid:'device-1'})).player).toMatchObject({points,times});
    expect(await db.one('SELECT points,times FROM player WHERE id=2')).toEqual({points,times});
    expect(await db.one('SELECT pool FROM operation WHERE id=1')).toEqual({pool});
    expect(await db.query('SELECT * FROM record')).toHaveLength(status === 400 ? 1 : 0);
    // getDevice precedes score validation in Yii, so even a required-value error
    // retains the observed device IP write instead of rolling it back.
    expect(await db.one('SELECT ip FROM device WHERE id=1')).toEqual({ip:'127.0.0.1'});
  });
  test('a nonnumeric score that survives PHP string comparisons retains its arithmetic warning and record',async()=>{
    await boot();await db.insert('record',{device_id:1,player_id:2,status:'running',game:{points:10,secodes:60}});
    await expect(call('POST','/v1/game/finish',{points:'0abc'},{uuid:'device-1'})).rejects.toMatchObject({status:500,responseBody:{name:'PHP Warning',message:'A non-numeric value encountered',code:2,type:'yii\\base\\ErrorException'}});
    expect(await db.one('SELECT points,times FROM player WHERE id=2')).toEqual({points:50,times:0});
    expect(await db.query('SELECT * FROM record')).toHaveLength(1);
    expect(await db.one('SELECT ip FROM device WHERE id=1')).toEqual({ip:'127.0.0.1'});
  });
  test.each(['start','restart','finish'])('game %s keeps source device registration before a missing-record error',async action=>{
    await boot();
    await expect(call('POST','/v1/game/'+action,{}, {uuid:'registered-before-error'})).rejects.toMatchObject({status:400,message:'No record'});
    expect(await db.one('SELECT uuid,version,ip FROM device WHERE uuid=?',['registered-before-error'])).toEqual({uuid:'registered-before-error',version:1,ip:'127.0.0.1'});
  });
  test('checkin ready and report retain source failures without creating or overwriting Redis state',async()=>{
    await boot();
    await expect(call('POST','/v1/checkin/ready',{token:'fresh',openid:'owner'})).rejects.toMatchObject({status:500,responseBody:{name:'Unknown Property',type:'yii\\base\\UnknownPropertyException'}});
    expect(await redis.all('checkin')).toEqual([]);
    await redis.save('checkin',{token:'existing',openid:'owner',status:'linked'});
    expect(await call('POST','/v1/checkin/ready',{token:'existing',openid:'owner'},{fields:'token'})).toEqual({success:true,message:'already checkin',data:{token:'existing'}});
    await expect(call('POST','/v1/checkin/ready',{token:'existing',openid:'other'})).rejects.toMatchObject({status:500});
    expect(await redis.find('checkin','existing')).toEqual({token:'existing',openid:'owner',status:'linked'});
    await redis.save('report',{token:'existing',device:'original',status:'ready'});
    await expect(call('POST','/v1/checkin/report',{token:'existing',device:'changed',action:'start'})).rejects.toMatchObject({status:500,responseBody:{message:'Setting unknown property: app\\modules\\v1\\models\\Report::action'}});
    expect(await redis.find('report','existing')).toEqual({token:'existing',device:'original',status:'ready'});
  });
  test('local refresh retains partial writes before missing typed parameters fail',async()=>{
    await boot();const time='123',token='F'+'f'.repeat(32);
    const query={time,hash:createHash('md5').update(token+time+'AR'+'buj1aban.c0m').digest('hex')};
    await expect(call('POST','/v1/local/refresh',{token,device:'AR',status:'running'},query)).rejects.toMatchObject({status:500,responseBody:{type:'TypeError'}});
    expect(await redis.find('report',token)).toMatchObject({device:'AR',status:'running'});
    expect(await redis.find('checkin',token)).toBeNull();
    const ownerToken='G'+'a'.repeat(32),ownerQuery={time,hash:createHash('md5').update(ownerToken+time+'owner'+'buj1aban.c0m').digest('hex')};
    await expect(call('POST','/v1/local/refresh',{token:ownerToken,openid:'owner',status:'ready'},ownerQuery)).rejects.toMatchObject({status:500,responseBody:{type:'TypeError'}});
    expect(await redis.find('checkin',ownerToken)).toMatchObject({openid:'owner',status:'ready'});
    expect(await redis.find('recode_file',ownerToken)).toBeNull();
  });
});
