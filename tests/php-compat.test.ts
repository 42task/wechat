import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { copyPhpMetadata, normalizePhpJson, parsePhpJson, parsePhpParameters, phpFloatString, phpInt, phpIntegerValid, phpNumberType, phpTrim, phpValuesEqual } from '../src/core/php';
import { Database } from '../src/core/database';
import { validateConfiguration, normalizeDevice } from '../src/admin/devices';
import { buildRedisKey } from '../src/core/redis';
import { ApiError, errorPayload } from '../src/core/errors';
import { createApplication } from '../src/application';
import { AuthService } from '../src/core/auth';
import { Integrations } from '../src/integrations/integrations';
import { AdminTokens } from '../src/admin/tokens';
import { sha256 } from '../src/admin/sessions';
import type { Services } from '../src/core/contracts';
import { bodyDeviceId } from '../src/v2/resources';

describe('PHP request and scalar compatibility', () => {
  // Expected results captured from PHP parse_str(), including its sparse arrays.
  it.each([
    ['', []],
    ['a=first&a=last', { a: 'last' }],
    ['a=first&a[]=second', { a: ['second'] }],
    ['a[]=first&a=second', { a: 'second' }],
    ['a[x]=first&a[x][]=second', { a: { x: ['second'] } }],
    ['pictures[0]=a&pictures[2]=b', { pictures: { 0: 'a', 2: 'b' } }],
    ['pictures[1]=x', { pictures: { 1: 'x' } }],
    ['a[2]=x&a[0]=y&a[1]=z', { a: { 2: 'x', 0: 'y', 1: 'z' } }],
    ['a[][]=1&a[][]=2', { a: [['1'], ['2']] }],
    ['a[02]=x&a[-2]=y&a[]=z', { a: { '02': 'x', '-2': 'y', '-1': 'z' } }],
    ['a[9223372036854775807]=x&a[]=y', { a: { '9223372036854775807': 'x' } }],
    ['a[b=1', { a_b: '1' }],
    ['a[b][c=x', { a: { b: 'x' } }],
    ['a[b]tail=1', { a: { b: '1' } }],
    ['+a.b[c+d]=one+two', { a_b: { 'c d': 'one two' } }],
    ['a%00ignored=x', { a: 'x' }],
  ])('matches parse_str for %s', (raw, expected) => {
    expect(parsePhpParameters(raw as string)).toEqual(expected);
  });
  it('accepts Express null query strings and keeps special names as data', () => {
    expect(parsePhpParameters(null)).toEqual([]);
    expect(parsePhpParameters(undefined)).toEqual([]);
    const values = parsePhpParameters('__proto__[safe]=yes&constructor=ordinary');
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(values.__proto__.safe).toBe('yes');
    expect(values.constructor).toBe('ordinary');
    expect(({} as any).safe).toBeUndefined();
  });
  it.each([
    ['1e2', 100], ['1.8x', 1], ['1e2x', 100], ['abc', 0], ['', 0], [' -1.8x', -1],
    [[], 0], [[1], 1], [{}, 0], [{ a: 1 }, 1], [null, 0], [true, 1], [false, 0],
  ])('casts %j to the PHP integer %d', (input, expected) => { expect(phpInt(input)).toBe(expected); });
  it('uses PHP whitespace for Redis numeric keys without hashing numeric notation', () => {
    for (const key of ['1e+20', '.5', ' 123 ', '-12', '1.25', '+.5', '1.']) expect(buildRedisKey(key)).toBe(key);
    expect(buildRedisKey('normal-token')).toBe('a2d63a2c81875faaa1bf6aa58c0f89aa');
  });
  it('keeps PHP positive device-id casts without adding a JavaScript safe-integer limit', () => {
    expect(bodyDeviceId('9007199254740993')).toBe(Number(9007199254740993n));
    expect(bodyDeviceId('9223372036854775808')).toBe(Number(9223372036854775807n));
    expect(bodyDeviceId('9'.repeat(400))).toBe(0);
    const integer = parsePhpJson('{"device_id":1}'), floating = parsePhpJson('{"device_id":1.0}');
    expect(bodyDeviceId(integer.device_id, phpNumberType(integer, 'device_id'))).toBe(1);
    expect(() => bodyDeviceId(floating.device_id, phpNumberType(floating, 'device_id'))).toThrow('device_id 必须为有效设备编号');
    for (const value of ['1\n', '1\r', '1\u2028', '01', 0, -1, '0']) expect(() => bodyDeviceId(value)).toThrow('device_id 必须为有效设备编号');
  });
  it('uses PHP precision14 before integer validation and its separate database cast', () => {
    const back = 100 * (57 / 100), pool = back - 28;
    expect(phpFloatString(back)).toBe('57');
    expect(phpFloatString(pool)).toBe('29');
    expect(phpIntegerValid(pool, 'double')).toBe(true);
    expect(phpInt(pool)).toBe(28);
    expect(phpFloatString(0.00001)).toBe('1.0E-5');
    expect(phpFloatString(100000000000000)).toBe('1.0E+14');
    expect(phpIntegerValid(100000000000000, 'double')).toBe(false);
    expect(phpIntegerValid(100000000000000, 'integer')).toBe(true);
    expect(phpFloatString(-0)).toBe('-0');
    for (const input of [1.5, '1e2', true, [], null, '1\r', '1\u2028']) expect(phpIntegerValid(input)).toBe(false);
    expect(phpIntegerValid('1\n')).toBe(true);
  });
  it('preserves NBSP and removes the PHP default trim characters', () => {
    expect(phpTrim('\0\v \tName\r\n\0')).toBe('Name');
    expect(phpTrim('\u00a0Name\u00a0')).toBe('\u00a0Name\u00a0');
    expect(validateConfiguration({ title: '\u00a0Name\u00a0', slogans: ['\u00a0keep\u00a0', '\u00a0'] })).toEqual({ title: '\u00a0Name\u00a0', slogans: ['\u00a0keep\u00a0', '\u00a0'] });
    expect(validateConfiguration({ title: '\0Name\0', pictures: ['\0image\0', '\0'] })).toEqual({ title: 'Name', pictures: ['image'] });
    expect(normalizeDevice({ id: 1, uuid: 'device' }, { title: '\u00a0Name\u00a0' }).name).toBe('\u00a0Name\u00a0');
  });
  it('decodes PHP JSON objects as arrays without losing raw numeric-key order', () => {
    expect(parsePhpJson('{"empty":{},"list":{"0":"a","1":"b"}}')).toEqual({ empty: [], list: ['a', 'b'] });
    const reordered = parsePhpJson('{"1":"b","0":"a"}');
    expect(Array.isArray(reordered)).toBe(false);
    expect(reordered).toEqual({ 0: 'a', 1: 'b' });
    expect(phpValuesEqual(reordered, parsePhpJson('{"0":"a","1":"b"}'))).toBe(false);
    expect(normalizePhpJson({ empty: {}, list: { 0: 'a', 1: 'b' } })).toEqual({ empty: [], list: ['a', 'b'] });
  });
  it('keeps integer and float lexemes for Yii strict dirty comparisons', () => {
    const parsed = parsePhpJson('{"integer":250,"float":250.0,"exponent":2.5e2,"nested":[1.0,1]}');
    expect(phpNumberType(parsed, 'integer')).toBe('integer');
    expect(phpNumberType(parsed, 'float')).toBe('double');
    expect(phpNumberType(parsed, 'exponent')).toBe('double');
    expect(phpNumberType(parsed.nested, '0')).toBe('double');
    expect(phpNumberType(parsed.nested, '1')).toBe('integer');
    expect(phpValuesEqual(parsed.integer, parsed.float, phpNumberType(parsed, 'integer'), phpNumberType(parsed, 'float'))).toBe(false);
    expect(phpValuesEqual(parsed.float, parsed.exponent, 'double', 'double')).toBe(true);
    expect(phpNumberType(copyPhpMetadata(parsed, { ...parsed }), 'float')).toBe('double');
    expect(phpValuesEqual(parsePhpParameters('a[x]=one').a, { x: 'one' })).toBe(true);
    expect(phpValuesEqual(parsePhpJson('{"b":1,"a":2}'), parsePhpJson('{"a":2,"b":1}'))).toBe(true);
    expect(phpValuesEqual(parsePhpJson('{"nested":[1.0]}'), parsePhpJson('{"nested":[1]}'))).toBe(false);
  });
  it('normalizes database JSON and retains MySQL floating-point column types', async () => {
    const row = { money: 250, slogans: '{"0":"a","1":"b"}' };
    const pool = { query: vi.fn(async () => [[row], [{ name: 'money', type: 4 }, { name: 'slogans', type: 245, table: 'setup' }]]) };
    const database = new Database(pool as any);
    const rows = await database.query('SELECT money,slogans FROM setup');
    expect(rows[0].slogans).toEqual(['a', 'b']);
    expect(phpNumberType(rows[0], 'money')).toBe('double');
    expect(phpValuesEqual(rows[0].money, 250, phpNumberType(rows[0], 'money'), 'integer')).toBe(false);
  });
  it('rejects sparse form lists while preserving PHP scalar-to-list overwrite', () => {
    for (const raw of ['pictures[0]=a&pictures[2]=b', 'pictures[1]=x']) expect(() => validateConfiguration(parsePhpParameters(raw))).toThrow('pictures 必须为字符串列表');
    expect(validateConfiguration(parsePhpParameters('pictures=first&pictures[]=second'))).toEqual({ pictures: ['second'] });
  });
  it('preserves public exception namespaces and supports the Yii debug-off shape', () => {
    const error = new ApiError(500, 'Public source error', 'Unknown Property', 'yii\\base\\UnknownPropertyException');
    expect(errorPayload(error).body).toMatchObject({ type: 'yii\\base\\UnknownPropertyException' });
    vi.stubEnv('YII_DEBUG', 'false');
    try {
      expect(errorPayload(new ApiError(401, 'Invalid token')).body).toEqual({ name: 'Unauthorized', message: 'Invalid token', code: 0, status: 401 });
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('authenticated configuration body compatibility', () => {
  let app: INestApplication;
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ADMIN_USERNAME', 'compat-admin');
    vi.stubEnv('ADMIN_PASSWORD_HASH', 'local-fixture-hash');
    vi.spyOn(AdminTokens.prototype, 'identity').mockResolvedValue({ source: 'password', username: 'compat-admin', credentialFingerprint: sha256('local-fixture-hash') });
    const db = { query: vi.fn(async () => []), one: vi.fn(async () => null) };
    const services = { db, redis: { ping: async () => 'PONG' }, auth: new AuthService(db as any), catalog: {}, integrations: new Integrations() } as unknown as Services;
    app = await createApplication(services);
  });
  afterAll(async () => { await app?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it('distinguishes JSON null from an empty JSON object after authentication', async () => {
    const response = await supertest(app.getHttpServer()).put('/admin-api/devices/1/configuration').set('Content-Type', 'application/json').send('null').expect(422);
    expect(response.body.message).toBe('设备配置必须为 JSON 对象');
    const empty = await supertest(app.getHttpServer()).put('/admin-api/devices/1/configuration').send({}).expect(422);
    expect(empty.body.message).toBe('请仅提交需要修改的设备名称、游戏、口号、图片或缩略图');
  });
  it('retains sparse form list validation through the HTTP body parser', async () => {
    const response = await supertest(app.getHttpServer()).put('/admin-api/devices/1/configuration').type('form').send('pictures[0]=a&pictures[2]=b').expect(422);
    expect(response.body.message).toBe('pictures 必须为字符串列表');
  });
});
