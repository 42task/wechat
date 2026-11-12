import { createHash, randomInt } from 'node:crypto';
import { unescape } from 'node:querystring';
import type { ApiRouter } from '../core/router';
import type { Context, Row, Services } from '../core/contracts';
import { V1Models, fail, fieldNames, needed, phpTruthy, selectFields } from './models';
import { recordRequest, readRequest } from '../core/diagnostics';
import { ApiError } from '../core/errors';
import { copyPhpMetadata, phpInt, phpIntegerValid, phpNumberType, setPhpNumberType, type PhpNumberType } from '../core/php';

const result=(message='success', data:Row={}) => ({success:true,message,...data});
const sec=() => String(Math.floor(Date.now()/1000));
function legacyFailure(name:string,message:string,type:string,code=0):never {
  const error=new ApiError(500,message);
  // Preserve the public exception contract without PHP paths or stack traces.
  error.responseBody={name,message,code,type};
  throw error;
}
function legacyString(value:unknown,method:string,parameter:string):string {
  if (value === null || value === undefined || typeof value === 'object') {
    const type=value === null || value === undefined ? 'null' : 'array';
    return legacyFailure('Exception',`app\\modules\\v1\\controllers\\LocalController::${method}(): Argument #2 ($${parameter}) must be of type string, ${type} given`,'TypeError');
  }
  return typeof value === 'boolean' ? value ? '1' : '' : String(value);
}
const numericString=/^[ \t\n\r\f\v]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\f\v]*$/;
function compareScore(value:unknown,budget:number):number {
  // PHP 8 compares numeric strings numerically, nonnumeric strings against the
  // number's string form, booleans as booleans, and JSON arrays above numbers.
  if (typeof value === 'boolean') return Number(value)-Number(phpTruthy(budget));
  if (value !== null && typeof value === 'object') return 1;
  if (typeof value === 'string' && !numericString.test(value)) return value < String(budget) ? -1 : value > String(budget) ? 1 : 0;
  const number=Number(value);
  return number < budget ? -1 : number > budget ? 1 : 0;
}
function arithmeticScore(value:unknown):number {
  if (typeof value === 'string' && !numericString.test(value)) {
    if (/^[ \t\n\r\f\v]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.test(value)) {
      return legacyFailure('PHP Warning','A non-numeric value encountered','yii\\base\\ErrorException',2);
    }
    return legacyFailure('Exception','Unsupported operand types: int + string','TypeError');
  }
  return Number(value);
}
function numericType(value:unknown,known?:PhpNumberType):PhpNumberType {
  if (known) return known;
  if (typeof value === 'string') return /[.eE]/.test(value) ? 'double' : 'integer';
  return typeof value === 'number' && (!Number.isInteger(value) || value >= Number(9223372036854775807n) || value < Number(-9223372036854775808n)) ? 'double' : 'integer';
}
function arithmeticType(value:number,...inputs:PhpNumberType[]):PhpNumberType {
  return inputs.includes('double') ? 'double' : numericType(value);
}
function actionParameters(c:Context,names:string[]):Row {
  const parameters={...c.query,...c.params};
  const missing=names.filter(name=>!Object.prototype.hasOwnProperty.call(parameters,name));
  if (missing.length) throw new ApiError(400,'Missing required parameters: '+missing.join(', '));
  return Object.fromEntries(names.map(name=>[name,parameters[name]]));
}
function v1BearerStructure(c:Context):void {
  // The v1 CompositeAuth uses bizley JwtHttpBearerAuth, whose parser exceptions
  // escape before the shared identity lookup or WWW-Authenticate challenge.
  const header=c.req.headers.authorization;
  const token=typeof header === 'string' ? /^Bearer\s+(.*?)$/.exec(header)?.[1] : undefined;
  if (!phpTruthy(token)) return;
  const parts=token!.split('.');
  let message:string|undefined;
  if (parts.length !== 3) message='The JWT string must have two dots';
  else if (parts[0] === '') message='The JWT string is missing the Header part';
  else if (parts[1] === '') message='The JWT string is missing the Claim part';
  else if (parts[2] === '') message='The JWT string is missing the Signature part';
  if (message) legacyFailure('Exception',message,'Lcobucci\\JWT\\Token\\InvalidTokenStructure');
}
// PHP's urldecode runs after the framework has already decoded the query string.
const deviceUuid=(c:Context) => unescape(String(c.query.uuid ?? '').replace(/\+/g,' '));
const redisAttributes:Record<string,string[]>={
  checkin:['token','openid','unionid','status','data','created_at','updated_at'],
  report:['token','device','status','data','setup','created_at','updated_at'],
  recode_file:['token','key','created_at','updated_at','dbid'],
};
function redisRow(model:string,row:Row|null,fields:unknown=''):Row|null {
  if (!row) return null;
  // Redis ActiveRecord exposes populated attributes only, not absent fields
  // filled with null. Preserve that distinction for shared v1/v2 Redis rows.
  const value=Object.fromEntries(Object.entries(row).filter(([key]) => redisAttributes[model].includes(key)));
  return selectFields(value,fields);
}
export function registerV1(router: ApiRouter, s: Services): void {
  const models=new V1Models(s.db);
  const record=(c:Context,action:string) => recordRequest(s,c,action);
  const bearer=(c:Context) => {v1BearerStructure(c);return s.auth.bearer(c,'v1-player');};
  const issuer=(c:Context) => c.req.protocol+'://'+c.req.get('host');
  const loadedManagers=new WeakMap<Row,Row>();
  const manager=async(c:Context,authenticated?:Row) => {const user=authenticated ?? await bearer(c),membership=await models.manager(user.id);if (!membership) fail(400,'Not Manager');loadedManagers.set(user,membership!);return user;};
  const add=(method:string|string[],path:string,handler:(c:Context)=>any) => router.add(method,'/v1/'+path,handler);
  const serialize=async(table:string,row:Row,c:Context) => {
    const value=await models.serialize(table,row,typeof c.query.expand === 'string' ? c.query.expand : '',typeof c.query.fields === 'string' ? c.query.fields : '');
    // User differs from Player: only its already-loaded manager relation is an
    // extra field; Player's explicitly declared role extra does not apply here.
    if (table === 'user' && loadedManagers.has(row) && fieldNames(c.query.expand).some(field=>field.split('.')[0] === 'manager')) {
      const nested=fieldNames(c.query.fields).filter(field=>field.startsWith('manager.')).map(field=>field.slice('manager.'.length)).join(',');
      value.manager=selectFields(loadedManagers.get(row)!,nested);
    }
    return value;
  };
  const rest=(path:string,table:string,authenticated=true) => {
    const guard=async(c:Context) => {if (authenticated) await bearer(c);};
    add(['GET','HEAD'],path,async c => {await guard(c);return models.list(table,c);});
    add(['GET','HEAD'],path+'/:id',async c => {await guard(c);const row=await models.find(table,c.params.id);if (!row) fail(404,'Object not found: '+c.params.id);return serialize(table,row!,c);});
    add('POST',path,async c => {await guard(c);const row=await models.save(table,c.body,undefined,undefined,true);c.res.status(201);c.res.setHeader('Location',issuer(c)+'/v1/'+path+'/'+row.id);return serialize(table,row,c);});
    add(['PUT','PATCH'],path+'/:id',async c => {await guard(c);const row=await models.find(table,c.params.id);if (!row) fail(404,'Object not found: '+c.params.id);return serialize(table,await models.save(table,c.body,row!,undefined,true),c);});
    add('DELETE',path+'/:id',async c => {await guard(c);if (!await models.find(table,c.params.id)) fail(404,'Object not found: '+c.params.id);await s.db.delete(table,c.params.id);c.res.status(204);return null;});
    add('OPTIONS',path,c => {c.res.setHeader('Allow','GET, POST, HEAD, OPTIONS');return null;});
    add('OPTIONS',path+'/:id',c => {c.res.setHeader('Allow','GET, PUT, PATCH, DELETE, HEAD, OPTIONS');return null;});
  };

  add('GET','common/test',() => '1123');
  add('POST','common/refresh-token',async c => result('refresh success',{token:await s.auth.refresh(String(c.body.refreshToken ?? ''),'v1-player',issuer(c))}));
  add('POST','common/sign-in',async c => {
    s.auth.playerFingerprint(c);await record(c,'sign-in');
    const row=await models.where('player','openId',c.body.openId ?? null);
    if (!row) return {success:false,player:null,message:'no signup'};
    return result('success',{player:await models.player(row),token:await s.auth.issue(row,'v1-player',issuer(c))});
  });
  add('POST','common/sign-up',async c => {
    s.auth.playerFingerprint(c);await record(c,'sign-up');needed(c.body.tel,'No Tel');
    let row=await models.where('player','openId',c.body.openId ?? null);const existed=Boolean(row);
    if (!row) row=await models.save('player',{tel:c.body.tel,openId:c.body.openId},undefined,'Invalid parameters');
    return result(existed?'already signup':'success',{player:await models.player(row),token:await s.auth.issue(row,'v1-player',issuer(c))});
  });
  add('GET','web/async-routes',async c => {await bearer(c);return {success:true,data:[]};});
  add('GET','helper/test',async c => {await record(c,'test');return null;});
  add('GET','helper/print',() => readRequest(s));

  add('GET','system/player-info',async c => {const user=await bearer(c),{targetId}=actionParameters(c,['targetId']);await manager(c,user);const row=await models.require('player',targetId,'No Player');return result('success',{target:await models.player(row)});});
  add('GET','system/reset-shop',async c => {
    await bearer(c);const {shopId}=actionParameters(c,['shopId']),op=await models.where('operation','shop_id',shopId);if (!op) fail(400,'No Operation');
    return result('success',{operation:await serialize('operation',await s.db.update('operation',op!.id,{pool:0,turnover:0,income:0}),c)});
  });
  // The source give action only validates money and saves the unchanged target.
  add('POST','system/give',async c => {
    const user=await manager(c);const target=await models.require('player',c.body.targetId,'No Player');needed(c.body.money,'No Money');
    const saved=await models.save('player',{},target,undefined,true);return result('success',{user:await serialize('user',user,c),player:await serialize('user',saved,c)});
  });
  add('POST','system/deduct-points',async c => {
    await manager(c);const supplied=needed(c.body.points,'No Points');
    return s.db.transaction(async db => {
      const m=new V1Models(db), player=await m.require('player',c.body.targetId ?? null,'No Player',true);
      if (compareScore(supplied,Number(player.points))>0) fail(400,'Not Enough Points');
      const points=Number(player.points)-arithmeticScore(supplied);
      const type=arithmeticType(points,numericType(player.points,phpNumberType(player,'points')),numericType(supplied,phpNumberType(c.body,'points')));
      if (!phpIntegerValid(points,type)) legacyFailure('Exception','json_decode(): Argument #1 ($json) must be of type string, array given','TypeError');
      const changes={points};setPhpNumberType(changes,'points',type);
      const saved=await m.save('player',changes,player,undefined,true);
      return result('success',{player:await serialize('player',saved,c)});
    });
  });
  add('GET','system/ready-game',async c => {
    const user=await bearer(c),{targetId,deviceId}=actionParameters(c,['targetId','deviceId']);await manager(c,user);
    return s.db.transaction(async db => {
      const m=new V1Models(db);
      const player=await m.require('player',targetId,'No Player',true);
      const device=await m.require('device',deviceId,'No Device',true);
      const existing=await db.one('SELECT * FROM record WHERE player_id = ? AND device_id = ?',[player.id,device.id]);
      if (existing) fail(400,'Already Running');
      const shop=await m.require('shop',device.shop_id,'No Shop',true);
      const cost=Number(player.cost ?? 0)+Number(shop.price ?? 0);
      if (cost>Number(player.recharge ?? 0)+Number(player.give ?? 0)) fail(400,'Not Enough Money');
      const operation=await m.operation(shop.id);
      const price=Number(shop.price ?? 0), percentage=Number(shop.rate ?? 0)/100, back=price*percentage;
      const backType:PhpNumberType=Number.isInteger(percentage) ? 'integer' : 'double';
      const pool=Number(operation.pool ?? 0)+back;
      const lower=Math.floor(pool/2), upper=Math.trunc(pool);
      if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || upper<lower) fail(400,'Invalid parameters');
      const restore=randomInt(lower,upper+1);
      const info={price,old_turnover:operation.turnover,old_pool:operation.pool};
      const balances={pool:pool-restore,turnover:Number(operation.turnover ?? 0)+price,income:Number(operation.income ?? 0)+(price-back)};
      // PHP precision=14 can validate a near-integer double, while the SQL
      // ColumnSchema's later (int) cast truncates its original binary value.
      if (Object.entries(balances).some(([key,value])=>!phpIntegerValid(value,key === 'turnover' ? 'integer' : backType))) fail(400,'Invalid parameters[]');
      await db.update('operation',operation.id,Object.fromEntries(Object.entries(balances).map(([key,value])=>[key,phpInt(value)])));
      const game={secodes:shop.play_time,points:restore};
      const row=await m.save('record',{player_id:player.id,device_id:device.id,game});
      const playerChanges={cost};setPhpNumberType(playerChanges,'cost',arithmeticType(cost,numericType(player.cost,phpNumberType(player,'cost')),'integer'));
      await m.save('player',playerChanges,player);
      await m.save('device',{},device);await m.save('shop',{},shop);
      return result('success',{info,record:await m.serialize('record',row,'player,device')});
    });
  });
  add('POST','system/close-record',async c => {
    await manager(c);
    return s.db.transaction(async db => {
      const recordId=c.body.recordId ?? null,description=recordId === null ? '' : typeof recordId === 'boolean' ? recordId ? '1' : '' : String(recordId);
      const m=new V1Models(db), row=await m.require('record',typeof recordId === 'boolean' ? Number(recordId) : recordId,'No Record:'+description,true);
      const device=await m.require('device',row.device_id,'No Device',true);
      const shop=await m.require('shop',device.shop_id,'No Shop',true), player=await m.require('player',row.player_id,'No Player',true);
      const operation=await m.operation(shop.id), game=(await m.serialize('record',row)).game;
      const price=Number(shop.price ?? 0), percentage=Number(shop.rate ?? 0)/100, back=price*percentage;
      const backType:PhpNumberType=Number.isInteger(percentage) ? 'integer' : 'double';
      const cost=Number(player.cost ?? 0)-price;
      const operationChanges={pool:Number(operation.pool ?? 0)+Number(game?.points ?? 0)-back,income:Number(operation.income ?? 0)-(price-back),turnover:Number(operation.turnover ?? 0)-price};
      const restoreType=numericType(game?.points,game && typeof game === 'object' ? phpNumberType(game,'points') : undefined);
      const operationTypes:Record<string,PhpNumberType>={pool:arithmeticType(operationChanges.pool,restoreType,backType),income:backType,turnover:'integer'};
      // Yii validates both models before saving either one. Its error branch
      // passes getErrors()'s array to json_decode(), so invalid fractional pool
      // or income values fail here without refunding, rounding, or deleting.
      if (!Number.isFinite(cost) || Object.entries(operationChanges).some(([key,value])=>!phpIntegerValid(value,operationTypes[key]))) {
        legacyFailure('Exception','json_decode(): Argument #1 ($json) must be of type string, array given','TypeError');
      }
      const playerChanges={cost};setPhpNumberType(playerChanges,'cost',arithmeticType(cost,numericType(player.cost,phpNumberType(player,'cost')),'integer'));
      const savedPlayer=await m.save('player',playerChanges,player,undefined,true);
      await db.update('operation',operation.id,Object.fromEntries(Object.entries(operationChanges).map(([key,value])=>[key,phpInt(value)])));
      // save() does not reload Operation: the response retains its assigned
      // doubles even though its integer SQL columns contain truncated values.
      const savedOp=copyPhpMetadata(operation,{...operation,...operationChanges});
      for (const [key,type] of Object.entries(operationTypes)) setPhpNumberType(savedOp,key,type);
      await db.delete('record',row.id);
      return result('success',{player:await serialize('player',savedPlayer,c),operation:await serialize('operation',savedOp,c)});
    });
  });

  const getDevice=async(c:Context,m:V1Models) => {
    const uuid=deviceUuid(c);let device=await m.where('device','uuid',uuid);
    const body={uuid,ip:c.req.ip ?? ''};
    device=await m.save('device',body,device ?? undefined,'Invalid device:');return device;
  };
  add(['GET','POST'],'game/device',async c => {
    const existing=await models.where('device','uuid',deviceUuid(c));
    const device=existing ?? await getDevice(c,models);
    return result(existing?'old device':'new device',{device:await serialize('device',device,c)});
  });
  add(['GET','POST'],'game/ready',async c => {
    const device=await getDevice(c,models), row=await models.where('record','device_id',device.id);
    if (!row) return {message:'No Ready',success:false};
    const game=(await models.serialize('record',row)).game;
    return result('Ready to play',{game,record:await serialize('record',row,c)});
  });
  for (const action of ['start','restart']) add(['GET','POST'],'game/'+action,async c => {
    // Source device registration/IP updates happen before record validation and
    // remain committed even when the later action returns an error.
    const device=await getDevice(c,models);
    return s.db.transaction(async db => {
      const m=new V1Models(db), found=await db.one('SELECT * FROM record WHERE device_id = ? LIMIT 1 FOR UPDATE',[device.id]);
      if (!found) fail(400,'No record');const row=found!;
      if (action === 'start' && row.status === 'running') fail(400,'Game is running');
      const saved=await m.save('record',{status:action === 'start'?'running':'ready'},row,'Invalid record');
      return result(action === 'start'?'Game start':'Game restart',action === 'start'?{game:(await m.serialize('record',saved)).game}:{});
    });
  });
  add(['GET','POST'],'game/finish',async c => {
    const device=await getDevice(c,models);
    return s.db.transaction(async db => {
      const m=new V1Models(db), found=await db.one('SELECT * FROM record WHERE device_id = ? LIMIT 1 FOR UPDATE',[device.id]);
      if (!found) fail(400,'No record');const row=found!;
      if (row.status !== 'running') fail(400,'Game is not running');
      let supplied=needed(c.body.points,'points is required');
      let suppliedType=numericType(supplied,phpNumberType(c.body,'points'));
      const player=await m.require('player',row.player_id,'No Player',true), shop=await m.require('shop',device.shop_id,'No Shop',true), op=await m.operation(shop.id);
      const game=(await m.serialize('record',row)).game, budget=Number(game?.points ?? 0);
      const budgetType=numericType(game?.points,game && typeof game === 'object' ? phpNumberType(game,'points') : undefined);
      if (compareScore(supplied,budget)>0) {supplied=budget;suppliedType=budgetType;}
      if (compareScore(supplied,0)<0) {supplied=0;suppliedType='integer';}
      const points=arithmeticScore(supplied);
      const playerChanges={points:Number(player.points ?? 0)+points,times:Number(player.times ?? 0)+1};
      const left=budget-points,pool=Number(op.pool ?? 0)+left;
      const playerPointsType=arithmeticType(playerChanges.points,numericType(player.points,phpNumberType(player,'points')),suppliedType);
      const poolType=arithmeticType(pool,budgetType,suppliedType);
      // Compatibility with GameController::actionFinish: save() validates each
      // model independently, ignores a failed integer validation, and still
      // deletes the record. Do not silently round fractional points in SQL.
      if (phpIntegerValid(playerChanges.points,playerPointsType) && phpIntegerValid(playerChanges.times,'integer')) await db.update('player',player.id,{points:phpInt(playerChanges.points),times:phpInt(playerChanges.times)});
      if (phpIntegerValid(pool,poolType)) await db.update('operation',op.id,{pool:phpInt(pool)});
      await db.delete('record',row.id);
      return result('Game over',{player:await m.player(await m.require('player',player.id,'No Player'))});
    });
  });

  const state=async(token:string,fields:unknown='') => ({checkin:redisRow('checkin',await s.redis.find('checkin',token),fields),report:redisRow('report',await s.redis.find('report',token),fields),file:redisRow('recode_file',await s.redis.find('recode_file',token),fields)});
  const save=async(model:string,row:Row) => {await s.redis.save(model,row);return redisRow(model,row)!;};
  const matchOwner=(row:Row|null,openid:any) => row && String(row.openid ?? '') === String(openid);
  add('GET','checkin/status',async c => {
    const token=String(needed(c.query.token,'token is required')), exists=await s.redis.find('checkin',token), current=await state(token,c.query.fields);
    return exists ? result('already checkin',{data:current}) : {success:false,message:'not checkin'};
  });
  add('POST','checkin/ready',async c => {
    const token=String(needed(c.body.token,'token is required')), openid=String(needed(c.body.openid,'openid is required'));
    const found=await s.redis.find('checkin',token);
    if (matchOwner(found,openid)) return result('already checkin',{data:redisRow('checkin',found,c.query.fields)});
    // The original action assigns a property absent from Checkin::attributes()
    // before saving. Keep its failure and leave the existing Redis row intact.
    return legacyFailure('Unknown Property','Setting unknown property: app\\modules\\v1\\models\\Checkin::file','yii\\base\\UnknownPropertyException');
  });
  for (const status of ['ready','linked']) add('POST','checkin/status-'+status,async c => {
    const token=String(needed(c.body.token,'token is required')), openid=String(needed(c.body.openid,'openid is required'));
    let row=await s.redis.find('checkin',token);
    if (!matchOwner(row,openid)) row={token,openid,created_at:sec()};
    if (row!.status !== status) row=await save('checkin',{...row,status,updated_at:sec()});
    const file=await s.redis.find('recode_file',token);
    return result('success',{data:{checkin:redisRow('checkin',row,c.query.fields),file:matchOwner(file,openid)?redisRow('recode_file',file,c.query.fields):null}});
  });
  add('POST','checkin/status-over',async c => {
    const token=String(needed(c.body.token,'token is required')), openid=needed(c.body.openid,'openid is required');
    if (!matchOwner(await s.redis.find('checkin',token),openid)) return {success:false,message:'not checkin'};
    await s.redis.remove('checkin',token);return result();
  });
  add('DELETE','checkin/close',async c => {
    const openid=needed(c.query.openid,'openid is required'), found=(await s.redis.all('checkin')).find(row => matchOwner(row,openid));
    if (found) {await s.redis.remove('checkin',found.token);return result();}return result('not checkin');
  });
  add('POST','checkin/upload',async c => {
    const token=String(needed(c.body.token,'token is required')), key=needed(c.body.key,'key is required');
    if (!await s.redis.find('checkin',token)) fail(400,'checkin not found');
    return result('file upload success',{data:redisRow('recode_file',await save('recode_file',{...await s.redis.find('recode_file',token),token,key,created_at:sec()}),c.query.fields)});
  });
  add('GET','checkin/files',async c => {
    const openid=needed(c.query.openid,'openid is required'), files=(await s.redis.all('recode_file')).filter(row => matchOwner(row,openid));
    return files.length ? result('files found',{data:files.map(file=>redisRow('recode_file',file,c.query.fields))}) : {success:false,message:'no files found',data:[]};
  });
  add('POST','checkin/report',async c => {
    const token=String(needed(c.body.token,'token is required'));
    needed(c.body.action,'action is required');needed(c.body.device,'device is required');
    await s.redis.find('report',token);
    // Report has no action attribute in the reference model; no write occurs.
    return legacyFailure('Unknown Property','Setting unknown property: app\\modules\\v1\\models\\Report::action','yii\\base\\UnknownPropertyException');
  });
  add('GET','local/test',() => readRequest(s));
  add('GET','local/log',async c => {
    const {token}=actionParameters(c,['token']);
    return result('success',{data:await state(String(token),c.query.fields)});
  });
  add(['GET','POST'],'local/refresh',async c => {
    await record(c,'refresh');
    const token=String(needed(c.body.token,'token is required')), time=needed(c.query.time,'time and hash are required'), hash=needed(c.query.hash,'time and hash are required');
    if (!/^[A-Z][0-9a-f]{32}$/i.test(token)) fail(400,'token format error');
    const supplied=['device','openid','key'].filter(key => phpTruthy(c.body[key]));
    if (supplied.length !== 1) fail(400,'Exactly one of device, openid, or key must be provided');
    const param=c.body[supplied[0]];
    if (createHash('md5').update(token+time+param+'buj1aban.c0m').digest('hex') !== hash) fail(400,'hash error');
    // The source calls all three helpers in order, even when only one of the
    // body fields is nonempty. Keep partial Redis writes preceding an exception.
    if (phpTruthy(c.body.device)) {
      const existing=await s.redis.find('report',token), row=existing ?? {token,device:c.body.device,created_at:sec()};
      for (const field of ['status','data']) if (phpTruthy(c.body[field])) row[field]=c.body[field];
      row.updated_at=sec();await save('report',row);
    }
    const openid=legacyString(c.body.openid,'getCheckin','openid');
    if (phpTruthy(openid)) {
      const existing=await s.redis.find('checkin',token), row=existing ?? {token,openid,created_at:sec()};
      for (const field of ['status','data']) if (phpTruthy(c.body[field])) row[field]=c.body[field];
      row.updated_at=sec();await save('checkin',row);
    }
    const key=legacyString(c.body.key,'getFile','key');
    if (phpTruthy(key)) {
      return legacyFailure('Exception','Call to undefined method app\\modules\\v1\\models\\File::Create()','Error');
    }
    return result('success',{data:await state(token,c.query.fields)});
  });

  // Static routes are registered first so they win over the inherited :id routes.
  for (const table of ['device','shop','player','record','award','gift']) rest(table,table);
  // DeviceFingerprintAuth in the source returns true unconditionally.
  rest('game','device',false);rest('helper','player',false);
}
