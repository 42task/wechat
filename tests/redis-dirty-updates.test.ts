import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context, Row, Services } from '../src/core/contracts';
import { buildRedisKey, LegacyRedis } from '../src/core/redis';
import { refresh } from '../src/v2/server';
import { copyPhpMetadata, parsePhpJson } from '../src/core/php';
import { ApiRouter } from '../src/core/router';
import { registerV1 } from '../src/v1';
import { createHash } from 'node:crypto';

/** Execute the Redis commands emitted by the real adapter, without a socket. */
class CommandRedis extends LegacyRedis {
  readonly hashes = new Map<string, Row>();
  readonly lists = new Map<string, string[]>();
  readonly strings = new Map<string, string>();
  readonly commands: string[][] = [];
  override async command(args: string[]): Promise<any> {
    this.commands.push(args);
    const [operation, key, ...values] = args;
    switch (operation) {
      case 'GET': return this.strings.get(key) ?? null;
      case 'SET': this.strings.set(key, values[0]); return 'OK';
      case 'INCR': { const value = Number(this.strings.get(key) ?? 0) + 1; this.strings.set(key, String(value)); return value; }
      case 'EXISTS': return Number(this.hashes.has(key));
      case 'RPUSH': { const pool = this.lists.get(key) ?? []; pool.push(...values); this.lists.set(key, pool); return pool.length; }
      case 'LRANGE': return this.lists.get(key) ?? [];
      case 'HGETALL': return Object.entries(this.hashes.get(key) ?? {}).flat();
      case 'HMSET': { const row = this.hashes.get(key) ?? {}; for (let i = 0; i < values.length; i += 2) row[values[i]] = values[i + 1]; this.hashes.set(key, row); return 'OK'; }
      case 'HDEL': { const row = this.hashes.get(key) ?? {}; for (const field of values) delete row[field]; if (Object.keys(row).length) this.hashes.set(key, row); else this.hashes.delete(key); return 1; }
      case 'EVAL': {
        // Only the adapter's unchanged legacy diagnostic upsert is used here.
        const [, count, hashKey, model, pk, ...attributes] = [key, ...values];
        if (count !== '2' || !key.includes("redis.call('HSET'")) throw new Error('Unexpected Lua command');
        if (!this.hashes.has(hashKey)) await this.command(['RPUSH', model, pk]);
        if (attributes.length) await this.command(['HMSET', hashKey, ...attributes]);
        return 1;
      }
      default: throw new Error(`Unexpected command ${operation}`);
    }
  }
}

class TwoReaderRedis extends CommandRedis {
  private readers = 0;
  private release!: () => void;
  private readonly bothRead = new Promise<void>(resolve => { this.release = resolve; });
  constructor(private readonly model: string) { super(); }
  override async find(model: string, pk: unknown): Promise<Row | null> {
    const snapshot = await super.find(model, pk);
    if (model === this.model && ++this.readers <= 2) {
      if (this.readers === 2) this.release();
      await this.bothRead;
    }
    return snapshot;
  }
}

describe('Yii Redis ActiveRecord dirty updates', () => {
  it('keeps independent changes from two stale readers', async () => {
    const redis = new CommandRedis();
    await redis.save('report', { token: 'sample', status: 'old', data: 'old' }, null);
    const a = (await redis.find('report', 'sample'))!, b = (await redis.find('report', 'sample'))!;
    await redis.save('report', { ...a, status: 'ready' }, a);
    await redis.save('report', { ...b, data: 'new-data' }, b);
    expect(await redis.find('report', 'sample')).toEqual({ token: 'sample', status: 'ready', data: 'new-data' });
    expect(redis.lists.get('report')).toEqual(['sample']);
  });

  it.each(['report', 'applet'])('uses old snapshots during overlapping %s protocol refreshes', async model => {
    const redis = new TwoReaderRedis(model);
    await redis.save(model, { token: 'sample', status: 'old', data: 'old', uuid: 'device', device_id: '1', id: 'person', user_id: '1' }, null);
    const services = { redis, auth: { requireDevice() {} }, db: { execute: async () => ({ affectedRows: 1 }) } } as unknown as Services;
    const context = (body: Row) => ({ body: { token: 'sample', ...model === 'report' ? { uuid: 'device' } : { id: 'person' }, ...body }, query: {}, params: {}, req: { method: 'POST', path: '/v2/server/refresh', headers: {} } }) as unknown as Context;
    await Promise.all([refresh(services, context({ status: 'ready' })), refresh(services, context({ data: 'new-data' }))]);
    expect(await redis.find(model, 'sample')).toMatchObject({ status: 'ready', data: 'new-data' });
    expect(redis.lists.get(model)).toEqual(['sample']);
  });

  it('does not touch Redis for a clean AR and does not create missing attributes', async () => {
    const redis = new CommandRedis();
    const previous = { token: 'sample', status: 'old' };
    await redis.save('report', previous, null); redis.commands.length = 0;
    await redis.save('report', { ...previous }, previous);
    expect(redis.commands).toEqual([]);
    expect(await redis.find('report', 'sample')).toEqual(previous);
  });

  it('deletes only explicitly changed null fields without reverting a concurrent field', async () => {
    const redis = new CommandRedis();
    const previous = { token: 'sample', status: 'old', data: 'old' };
    await redis.save('report', previous, null);
    await redis.save('report', { ...previous, status: 'ready' }, previous);
    await redis.save('report', { ...previous, data: null }, previous);
    expect(await redis.find('report', 'sample')).toEqual({ token: 'sample', status: 'ready' });
  });

  it('does not reinsert an old AR after another request deleted it', async () => {
    const redis = new CommandRedis(), previous = { token: 'sample', status: 'old' };
    await redis.save('report', { ...previous, status: 'ready' }, previous);
    expect(redis.hashes.size).toBe(0); expect(redis.lists.size).toBe(0);
  });

  it('appends every new AR insert and omits null without deleting an older hash value', async () => {
    const redis = new CommandRedis();
    await redis.save('checkin', { token: 'shared', openid: 'first', data: 'retained' }, null);
    await redis.save('checkin', { token: 'shared', openid: 'second', data: null }, null);
    expect(redis.lists.get('checkin')).toEqual(['shared', 'shared']);
    expect(await redis.find('checkin', 'shared')).toEqual({ token: 'shared', openid: 'second', data: 'retained' });
  });

  it('advances explicit numeric primary-key counters, preserves greater counters and keeps raw numeric keys', async () => {
    const redis = new CommandRedis();
    await redis.save('checkin', { token: '20', status: 'ready' }, null);
    await redis.save('checkin', { token: '10', status: 'ready' }, null);
    expect(redis.strings.get('checkin:s:token')).toBe('20');
    await redis.save('checkin', { token: '1e2', status: 'ready' }, null);
    expect(redis.strings.get('checkin:s:token')).toBe('1e2');
    expect(redis.lists.get('checkin')).toEqual(['20', '10', '1e2']);
    expect(await redis.find('checkin', '1e2')).toMatchObject({ token: '1e2' });
  });

  it.each(['0', '-1'])('matches PHP null-counter comparison for explicit string token %s', async token => {
    const redis = new CommandRedis();
    await redis.save('checkin', { token }, null);
    expect(redis.strings.get('checkin:s:token')).toBe(token);
    expect(redis.lists.get('checkin')).toEqual([buildRedisKey(token)]);
  });
});

const sourceRoot = resolve(process.env.YII2_SOURCE_ROOT || resolve(__dirname, '../../game'));
const sourceAvailable = existsSync(resolve(sourceRoot, 'api/vendor/yiisoft/yii2/Yii.php'));
describe.skipIf(!sourceAvailable)('offline original Yii Redis oracle', () => {
  it('matches source dirty-write behavior under the identical stale-reader schedule', async () => {
    const script = String.raw`
$root=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
require $root.'/api/vendor/autoload.php';require $root.'/api/vendor/yiisoft/yii2/Yii.php';Yii::setAlias('@app',$root.'/api');
class OriginalReportOracle extends app\modules\v2\models\Report {
  public static $stored=[];public static $writes=[];
  public static function updateAll($attributes,$condition=null){self::$writes[]=$attributes;self::$stored=array_merge(self::$stored,$attributes);return 1;}
}
$old=['token'=>'sample','status'=>'old','data'=>'old'];OriginalReportOracle::$stored=$old;
$a=new OriginalReportOracle();$b=new OriginalReportOracle();OriginalReportOracle::populateRecord($a,$old);OriginalReportOracle::populateRecord($b,$old);
$a->status='ready';$b->data='new-data';$a->save(false);$b->save(false);
echo json_encode(['stored'=>OriginalReportOracle::$stored,'writes'=>OriginalReportOracle::$writes],JSON_THROW_ON_ERROR);
`;
    const oracle = spawnSync('php', ['-d', 'display_errors=stderr', '-d', 'error_reporting=8191', '-r', script], { input: JSON.stringify(sourceRoot), encoding: 'utf8', timeout: 10000 });
    expect(oracle.error).toBeUndefined(); expect(oracle.status, oracle.stderr).toBe(0);
    const expected = JSON.parse(oracle.stdout), redis = new CommandRedis();
    const old = { token: 'sample', status: 'old', data: 'old' };
    await redis.save('report', old, null); redis.commands.length = 0;
    await redis.save('report', { ...old, status: 'ready' }, old);
    await redis.save('report', { ...old, data: 'new-data' }, old);
    expect(await redis.find('report', 'sample')).toEqual(expected.stored);
    const writes = redis.commands.filter(command => command[0] === 'HMSET').map(command => Object.fromEntries(Array.from({ length: (command.length - 2) / 2 }, (_, index) => [command[2 + index * 2], command[3 + index * 2]])));
    expect(writes).toEqual(expected.writes);
  });
});

const serializationCases = [
  ...['[1]', '{"a":1}', '[]', '{}', 'true', 'false', 'null', '12', '1.25', '1e14', '100000000000000', '-0.0', '1.2345678901234567'].flatMap(value => [true, false].map(fresh => ({
    new: fresh, token: '20', previous: { token: '20', status: 'old', data: 'old', uuid: 'old' }, rawChanges: `{"status":"ready","data":${value},"uuid":null}`,
  }))),
];

async function serializedNode(case_: typeof serializationCases[number]) {
  const redis = new CommandRedis(), key = 'report:a:20';
  if (!case_.new) { redis.hashes.set(key, { ...case_.previous }); redis.lists.set('report', ['20']); }
  const changes = parsePhpJson(case_.rawChanges);
  const row = copyPhpMetadata(changes, { ...case_.new ? { token: case_.token } : case_.previous, ...changes });
  let error: unknown = null;
  try { await redis.save('report', row, case_.new ? null : { ...case_.previous }); }
  catch (exception) { error = (exception as any).responseBody; }
  return { error, hash: redis.hashes.get(key) ?? null, list: redis.lists.get('report') ?? [], counter: redis.strings.get('report:s:token') ?? null,
    mutations: redis.commands.filter(command => ['RPUSH', 'HMSET', 'HDEL', 'SET', 'INCR'].includes(command[0])) };
}

describe('source Redis serialization failure boundaries', () => {
  it('uses the source non-debug exception envelope when debug is disabled', async () => {
    const previous = process.env.YII_DEBUG; process.env.YII_DEBUG = '0';
    try {
      const actual = await serializedNode(serializationCases[0]);
      expect(actual.error).toEqual({ name: 'Internal Server Error', message: 'An internal server error occurred.', code: 0, status: 500 });
    } finally { if (previous === undefined) delete process.env.YII_DEBUG; else process.env.YII_DEBUG = previous; }
  });

  it.each(serializationCases.filter(({ rawChanges }) => /"data":(?:\[|\{)/.test(rawChanges)))('keeps source partial insert/update effects for $new $rawChanges', async case_ => {
    const actual = await serializedNode(case_);
    expect(actual.error).toEqual({ name: 'Exception', message: 'mb_strlen(): Argument #1 ($string) must be of type string, array given', code: 0, type: 'TypeError' });
    expect(actual.hash).toEqual(case_.new ? null : case_.previous);
    expect(actual.list).toEqual(['20']);
    expect(actual.counter).toBe(case_.new ? '20' : null);
    expect(actual.mutations.map(command => command[0])).toEqual(case_.new ? ['SET', 'RPUSH'] : []);
  });

  it.each(['v1', 'v2'])('rejects nonempty array/object data at the %s request boundary and preserves old fields', async version => {
    for (const data of [[1], { a: 1 }]) {
      const redis = new CommandRedis(), token = `a${'1'.repeat(32)}`;
      const previous = { token, uuid: 'device', device_id: '1', device: 'AR', status: 'old', data: 'old' };
      await redis.save('report', previous, null);
      const services = { redis, auth: { requireDevice() {} }, db: { execute: async () => ({ affectedRows: 1 }) } } as unknown as Services;
      const time = '100', query = { time, hash: createHash('md5').update(token + time + 'ARbuj1aban.c0m').digest('hex') };
      const body = parsePhpJson(JSON.stringify({ token, ...version === 'v1' ? { device: 'AR', openid: '', key: '' } : { uuid: 'device' }, status: 'ready', data }));
      const ctx = { body, query, params: {}, req: { method: 'POST', path: `/${version}/${version === 'v1' ? 'local' : 'server'}/refresh`, headers: {} } } as unknown as Context;
      const router = new ApiRouter(); registerV1(router, services);
      const operation = version === 'v2' ? refresh(services, ctx) : router.match('POST', '/v1/local/refresh')!.route.handler(ctx);
      await expect(operation).rejects.toMatchObject({ status: 500, responseBody: { type: 'TypeError', message: 'mb_strlen(): Argument #1 ($string) must be of type string, array given' } });
      expect(await redis.find('report', token)).toEqual(previous);
    }
  });

  it.each(['v1', 'v2'])('preserves PHP float lexemes and ignores optional-empty data for %s', async version => {
    for (const [literal, expected] of [['1e14', '1.0E+14'], ['100000000000000', '100000000000000'], ['true', '1'], ['false', 'old'], ['null', 'old'], ['0', 'old'], ['[]', 'old'], ['{}', 'old']] as const) {
      const redis = new CommandRedis(), token = `a${'2'.repeat(32)}`;
      await redis.save('report', { token, uuid: 'device', device_id: '1', device: 'AR', data: 'old' }, null);
      const services = { redis, auth: { requireDevice() {} }, db: { execute: async () => ({ affectedRows: 1 }) } } as unknown as Services;
      const body = parsePhpJson(`{"token":"${token}",${version === 'v1' ? '"device":"AR","openid":"","key":""' : '"uuid":"device"'},"data":${literal}}`);
      const time = '100', query = { time, hash: createHash('md5').update(token + time + 'ARbuj1aban.c0m').digest('hex') };
      const ctx = { body, query, params: {}, req: { method: 'POST', path: `/${version}/${version === 'v1' ? 'local' : 'server'}/refresh`, headers: {} } } as unknown as Context;
      if (version === 'v2') await refresh(services, ctx);
      else { const router = new ApiRouter(); registerV1(router, services); await router.match('POST', '/v1/local/refresh')!.route.handler(ctx); }
      expect((await redis.find('report', token))!.data, `${version} ${literal}`).toBe(expected);
    }
  });
});

describe.skipIf(!sourceAvailable)('offline original source RESP serialization oracle', () => {
  it('matches actual Connection::executeCommand before send, including failure side effects', async () => {
    const oracle = spawnSync('php', ['-d', 'display_errors=stderr', '-d', 'error_reporting=8191', resolve(__dirname, 'redis-source-oracle.php')], { input: JSON.stringify({ root: sourceRoot, cases: serializationCases }), encoding: 'utf8', timeout: 10000 });
    expect(oracle.error).toBeUndefined(); expect(oracle.status, oracle.stderr).toBe(0);
    const expected = JSON.parse(oracle.stdout).results;
    for (const [index, case_] of serializationCases.entries()) expect(await serializedNode(case_), JSON.stringify(case_)).toEqual(expected[index]);
  });
});
