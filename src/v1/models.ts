import { HttpException } from '@nestjs/common';
import type { Context, Row } from '../core/contracts';
import type { Database } from '../core/database';
import { hasDecodedJson, markJsonDecoded } from '../core/json';
import { ApiError } from '../core/errors';
import { yiiObject } from '../core/serialization';
import { copyPhpMetadata, normalizePhpJson, parsePhpJson, phpInt, phpIntegerValid, phpNumberType, phpTrim, phpValuesEqual } from '../core/php';
import { paginationOrigin } from '../core/pagination';

export const fail = (status: number, message: string): never => { throw new ApiError(status, message, undefined, status === 400 ? 'HttpException' : undefined); };
export const phpTruthy = (value:any):boolean => value !== undefined && value !== null && value !== '' && value !== false && value !== 0 && value !== '0' && !(typeof value === 'object' && Object.keys(value).length === 0);
export const needed = (value: any, message: string): any => { if (!phpTruthy(value)) fail(400,message); return value; };
export const valueOf = (ctx: Context, key: string): any => ctx.params[key] ?? ctx.query[key] ?? ctx.body[key];
// Yii's REST Serializer accepts string lists and trims whitespace around commas.
export const fieldNames = (value: unknown): string[] => typeof value === 'string' ? value.split(/\s*,\s*/).filter(Boolean) : [];
export function selectFields(row: Row, fields: unknown): Row {
  const names=fieldNames(fields).map(field => field.split('.')[0]);
  if (!names.length || names.includes('*')) return row;
  const entries=Object.entries(row).filter(([key]) => names.includes(key));
  return copyPhpMetadata(row,entries.length ? Object.fromEntries(entries) : []);
}
const paginationInteger = (value: unknown, fallback: number): number => {
  if (value === undefined || value === null || typeof value === 'object') return fallback;
  return phpInt(value);
};
const label = (field: string): string => ({shop_id:'Shop ID',device_id:'Device ID',player_id:'Player ID',award_id:'Award ID',openId:'Openid',play_time:'Play Time'}[field] ?? field.charAt(0).toUpperCase()+field.slice(1));
const definitions: Record<string, {fields:string[]; required?:string[]; integers?:string[]; numbers?:string[]; strings?:string[]; unique?:string[]; foreign?:Record<string,string>}> = {
  player:{fields:['tel','nickname','openId','avatar','info','recharge','give','cost','times','grade','points','created_at','updated_at'],required:['tel'],integers:['times','grade','points'],numbers:['recharge','cost','give'],strings:['tel','nickname','openId','avatar'],unique:['tel','openId']},
  device:{fields:['shop_id','uuid','tag','ip','created_at','updated_at'],integers:['shop_id'],strings:['uuid','tag','ip'],unique:['uuid','tag'],foreign:{shop_id:'shop'}},
  shop:{fields:['price','play_time','rate','advanced','tag','created_at','updated_at'],integers:['price','play_time','rate','advanced'],strings:['tag']},
  record:{fields:['player_id','device_id','created_at','updated_at','startTime','endTime','game','status'],required:['player_id'],integers:['player_id','device_id'],strings:['status'],foreign:{device_id:'device',player_id:'player'}},
  award:{fields:['shop_id','price','type'],required:['shop_id'],integers:['shop_id','price'],strings:['type'],foreign:{shop_id:'shop'}},
  gift:{fields:['award_id','created_at','updated_at','info','uuid','tag','picture'],required:['award_id'],integers:['award_id'],strings:['uuid','tag','picture'],unique:['uuid'],foreign:{award_id:'award'}},
};
export class V1Models {
  constructor(readonly db: Database) {}
  async find(table: string, id: any, locked = false): Promise<Row | null> { return this.db.one(`SELECT * FROM \`${table}\` WHERE id = ?${locked ? ' FOR UPDATE' : ''}`, [id]); }
  async where(table: string, field: string, value: any): Promise<Row | null> { return this.db.one(`SELECT * FROM \`${table}\` WHERE \`${field}\` = ? LIMIT 1`,[value]); }
  async require(table: string, id: any, message: string, locked = false): Promise<Row> { return await this.find(table,id,locked) ?? fail(400,message); }
  async manager(playerId: any): Promise<Row | null> { return this.where('manager','player_id',playerId); }
  async operation(shopId: any): Promise<Row> { return await this.where('operation','shop_id',shopId) ?? await this.db.insert('operation',{shop_id:shopId}); }
  async timestamp(): Promise<string> {
    // TimestampBehavior stores the database's NOW(), not the Node host's zone.
    const row=await this.db.one('SELECT CURRENT_TIMESTAMP AS currentTimestamp');
    if (typeof row?.currentTimestamp !== 'string') fail(503,'Database timestamp is unavailable');
    return row!.currentTimestamp;
  }
  async player(row: Row): Promise<Row> { return copyPhpMetadata(row,{...row,role:(await this.manager(row.id))?.type ?? 'player'}); }
  async serialize(table: string, row: Row, expand = '', fields = '', depth = 0, loadedRelations: Row = {}): Promise<Row> {
    const result = copyPhpMetadata(row,{...row});
    if (!hasDecodedJson(row) && typeof result.game === 'string') { try { result.game=parsePhpJson(result.game); } catch {} }
    if (table === 'device') {
      delete result.created_at; delete result.updated_at;
      result.status = row.shop_id == null ? 'unset' : (await this.where('record','device_id',row.id))?.status ?? 'unused';
    }
    if (table === 'shop') {delete result.created_at;delete result.updated_at;}
    if (table === 'operation') {delete result.id;delete result.shop_id;}
    if (depth < 5) {
      const specs = fieldNames(expand), names=[...new Set(specs.map(x => x.split('.')[0]))];
      for (const name of names) {
        const nested = specs.filter(x => x.startsWith(name+'.')).map(x => x.slice(name.length+1)).join(',');
        const nestedFields = fieldNames(fields).filter(x => x.startsWith(name+'.')).map(x => x.slice(name.length+1)).join(',');
        let value: any;
        if (table === 'player' && name === 'role') value=(await this.manager(row.id))?.type ?? 'player';
        if (table === 'record' && name === 'player') { const p=await this.find('player',row.player_id); value=p ? await this.player(p) : null; }
        if (table === 'record' && name === 'device') { const d=await this.find('device',row.device_id); value=d ? await this.serialize('device',d,nested,nestedFields,depth+1) : null; }
        if (table === 'shop' && name === 'operation') value=await this.serialize('operation',await this.operation(row.id),nested,nestedFields,depth+1);
        if (table === 'shop' && name === 'awards') {
          const awards=await this.db.query('SELECT * FROM award WHERE shop_id = ?',[row.id]);
          value=await Promise.all(awards.map(award => this.serialize('award',award,nested,nestedFields,depth+1)));
        }
        if (table === 'shop' && name === 'gifts') {
          const gifts=await this.db.query('SELECT gift.* FROM gift INNER JOIN award ON award.id = gift.award_id WHERE award.shop_id = ?',[row.id]);
          // Shop::getGifts uses joinWith('award'), which eager-loads that
          // relation. Only these Gift instances expose it as an extra field;
          // inherited Gift REST reads have not loaded an award relation.
          const awards=await this.db.query('SELECT * FROM award WHERE shop_id = ?',[row.id]);
          const byId=new Map(awards.map(award=>[String(award.id),award]));
          value=await Promise.all(gifts.map(g => this.serialize('gift',g,nested,nestedFields,depth+1,{award:byId.get(String(g.award_id)) ?? null})));
        }
        if (table === 'gift' && name === 'award' && Object.hasOwn(loadedRelations,'award')) value=loadedRelations.award ? await this.serialize('award',loadedRelations.award,nested,nestedFields,depth+1) : null;
        if (value !== undefined) result[name]=value;
      }
    }
    const rootFields=fieldNames(fields).map(field => field.split('.')[0]), rootExpands=fieldNames(expand).map(field => field.split('.')[0]);
    if (rootFields.length && !rootFields.includes('*')) {
      const entries=Object.entries(result).filter(([key]) => rootFields.includes(key) || rootExpands.includes(key));
      return copyPhpMetadata(result,entries.length ? Object.fromEntries(entries) : []);
    }
    return result;
  }
  async save(table: string, body: Row, previous?: Row, validationPrefix?: string, modelResponse = false): Promise<Row> {
    const spec=definitions[table]; if (!spec) fail(404,'Not Found');
    const input=copyPhpMetadata(body,normalizePhpJson(body));
    const data=copyPhpMetadata(input,Object.fromEntries(Object.entries(input).filter(([key]) => spec.fields.includes(key))));
    const awardPrice=data.price === undefined ? previous?.price : data.price;
    if (table === 'award' && (awardPrice === undefined || awardPrice === null || awardPrice === '' || Array.isArray(awardPrice) && awardPrice.length === 0)) data.price=100;
    const assigned=copyPhpMetadata(data,{...data});
    const merged=copyPhpMetadata(data,copyPhpMetadata(previous ?? {},{...previous,...data})), errors:Row[]=[];
    const hasError=(field:string) => errors.some(error => error.field === field);
    const invalid=(field:string,message:string) => {if (!hasError(field)) errors.push({field,message});};
    const empty=(value:any) => value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0;
    const required=[...spec.required ?? []];
    if (table === 'record' && (!previous || previous.device_id !== null)) required.push('device_id');
    for (const field of required) if (empty(typeof merged[field] === 'string' ? phpTrim(merged[field]) : merged[field])) invalid(field,label(field)+' cannot be blank.');
    // ActiveRecord::save validates the complete model, including unchanged
    // attributes loaded from legacy rows. Only assigned values are cast for SQL.
    for (const field of spec.numbers ?? []) if (!hasError(field) && merged[field] !== undefined && merged[field] !== null && merged[field] !== '') {
      const value=Array.isArray(merged[field]) && merged[field].length === 0 ? 0 : merged[field];
      const text=String(value), normalized=text.endsWith('\n') ? text.slice(0,-1) : text;
      // PCRE $ accepts one final LF. It does not accept CR or Unicode line separators.
      if (!['number','string'].includes(typeof value) || !/^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/.test(normalized) || !Number.isFinite(Number(value))) invalid(field,label(field)+' must be a number.'); else if (Object.hasOwn(data,field)) data[field]=Number(value);
    }
    for (const field of spec.integers ?? []) if (!hasError(field) && merged[field] !== undefined && merged[field] !== null && merged[field] !== '') {
      // Yii skips optional empty arrays during validation, then casts numeric columns to zero.
      const value=Array.isArray(merged[field]) && merged[field].length === 0 ? 0 : merged[field];
      if (!phpIntegerValid(value,phpNumberType(merged,field))) invalid(field,label(field)+' must be an integer.'); else if (Object.hasOwn(data,field)) data[field]=phpInt(value);
    }
    for (const field of spec.strings ?? []) if (!hasError(field) && merged[field] != null) {
      if (typeof merged[field] !== 'string') invalid(field,label(field)+' must be a string.');
      else if (field !== 'status' && field !== 'type' && [...merged[field]].length > 255) invalid(field,label(field)+' should contain at most 255 characters.');
    }
    for (const field of spec.unique ?? []) if (!hasError(field) && !empty(merged[field])) {
      const existing=await this.where(table,field,merged[field]); if (existing && existing.id !== previous?.id) invalid(field,label(field)+' "'+merged[field]+'" has already been taken.');
    }
    for (const [field,target] of Object.entries(spec.foreign ?? {})) if (!hasError(field) && !empty(merged[field]) && !await this.find(target,merged[field])) invalid(field,label(field)+' is invalid.');
    if (table === 'award' && !hasError('shop_id') && !hasError('type') && !empty(merged.shop_id) && !empty(merged.type)) {
      // There is no composite SQL unique constraint. Existing duplicate pairs
      // must still fail validation when the first returned row is this model.
      const existing=await this.db.one('SELECT * FROM award WHERE shop_id = ? AND type = ?'+(previous ? ' AND id <> ?' : ''),[merged.shop_id,merged.type,...previous ? [previous.id] : []]);
      if (existing) invalid('shop_id',`The combination "${merged.shop_id}"-"${merged.type}" of Shop ID and Type has already been taken.`);
    }
    if (errors.length) {
      if (validationPrefix !== undefined) fail(400,validationPrefix+JSON.stringify(Object.fromEntries(errors.map(error => [error.field,[error.message]]))));
      throw new HttpException(errors,422);
    }
    for (const field of [...spec.integers ?? [],...spec.numbers ?? []]) if (data[field] === '') data[field]=null;
    if (table === 'device' && !previous) data.version=1;
    // AttributeBehavior::skipUpdateOnClean preserves timestamps when an existing
    // model is saved without changing any attributes (including system/give).
    const dirty=!previous || Object.entries(assigned).some(([key,value]) => !phpValuesEqual(value,previous[key] ?? null,phpNumberType(assigned,key),phpNumberType(previous,key)));
    if (!dirty) return modelResponse ? markJsonDecoded(copyPhpMetadata(assigned,copyPhpMetadata(previous!,{...previous,...assigned}))) : previous!;
    if (['player','device','shop','record','gift'].includes(table)) {data.updated_at=await this.timestamp();if (!previous) data.created_at=data.updated_at;}
    const saved=previous ? await this.db.update(table,previous.id,data) : await this.db.insert(table,data);
    if (!modelResponse) return saved;
    // ActiveController returns the saved model without refresh(): request values
    // keep their types, unset database defaults stay absent, and SQL expressions
    // remain attributes until a later SELECT reloads the record.
    const response:Row=copyPhpMetadata(assigned,copyPhpMetadata(previous ?? {},{...previous,...assigned,id:saved.id}));
    if (table === 'device' && !previous) response.version=1;
    if (['player','device','shop','record','gift'].includes(table)) {
      response.updated_at=yiiObject('Expression',{expression:'NOW()',params:[]});
      if (!previous) response.created_at=yiiObject('Expression',{expression:'NOW()',params:[]});
    }
    return markJsonDecoded(response);
  }
  async list(table:string, ctx:Context):Promise<Row[]> {
    const conditions:string[]=[], args:any[]=[];
    const filter=table === 'award' ? 'shop_id' : table === 'gift' ? 'award_id' : null;
    if (filter && ctx.query[filter] != null) {conditions.push('`'+filter+'` = ?');args.push(ctx.query[filter]);}
    const where=conditions.length ? ' WHERE '+conditions.join(' AND ') : '';
    const total=Number((await this.db.one(`SELECT COUNT(*) AS total FROM \`${table}\`${where}`,args))?.total ?? 0);
    const size=Math.max(1,Math.min(50,paginationInteger(ctx.query['per-page'],20)));
    const pageCount=Math.ceil(total/size), requestedPage=paginationInteger(ctx.query.page,1);
    const page=Math.max(1,Math.min(Math.max(1,pageCount),requestedPage));
    let sort='';
    if (ctx.query.sort) {
      const allowed=(await this.db.columns(table)).map(column => column.name);
      const clauses=String(ctx.query.sort).split(',').filter(Boolean).flatMap(field => {
        const desc=field.startsWith('-'), name=desc ? field.slice(1) : field;
        return allowed.includes(name) ? ['`'+name+'` '+(desc?'DESC':'ASC')] : [];
      }).slice(0,1);
      if (clauses.length) sort=' ORDER BY '+clauses.join(',');
    }
    ctx.res.setHeader('X-Pagination-Total-Count',String(total));ctx.res.setHeader('X-Pagination-Page-Count',String(pageCount));
    ctx.res.setHeader('X-Pagination-Current-Page',String(page));ctx.res.setHeader('X-Pagination-Per-Page',String(size));
    const pageLink=(target:number) => {
      const url=new URL(ctx.req.originalUrl ?? '/v1/'+table,paginationOrigin(ctx.req));
      for (const [key,value] of Object.entries(ctx.query)) url.searchParams.set(key,String(value));
      if (size === 20) url.searchParams.delete('per-page'); else url.searchParams.set('per-page',String(size));
      url.searchParams.set('page',String(target));
      return url.toString();
    };
    const links=[`<${pageLink(page)}>; rel=self`];
    if (pageCount>0) {
      links.push(`<${pageLink(1)}>; rel=first`,`<${pageLink(pageCount)}>; rel=last`);
      if (page>1) links.push(`<${pageLink(page-1)}>; rel=prev`);
      if (page<pageCount) links.push(`<${pageLink(page+1)}>; rel=next`);
    }
    ctx.res.setHeader('Link',links.join(', '));
    const rows=await this.db.query(`SELECT * FROM \`${table}\`${where}${sort} LIMIT ? OFFSET ?`,[...args,size,(page-1)*size]);
    return Promise.all(rows.map(row => this.serialize(table,row,typeof ctx.query.expand === 'string' ? ctx.query.expand : '',typeof ctx.query.fields === 'string' ? ctx.query.fields : '')));
  }
}
