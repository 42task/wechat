import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context, Row } from '../src/core/contracts';
import { SceneCatalog, sceneInteger } from '../src/admin/scenes';

const integerCases: Array<[unknown, string | null]> = [
  [1, '1'], [true, '1'], [false, null], [null, null], [1.5, null],
  ['1', '1'], ['+1', '1'], [' \t\v1\r\n', '1'], ['01', null], ['+01', null],
  ['1.0', null], ['1e0', null], ['1\f', null], ['1\0', null], ['\u00a01', null],
  [0, null], ['0', null], ['-1', null], [[], null], [{}, null],
  ['9007199254740993', '9007199254740993'],
  ['9223372036854775807', '9223372036854775807'],
  ['9223372036854775808', null], ['9999999999999999999999999', null],
];
const catalogCases = [
  { raw: '[{"verse_id":1,"name":"normal"}]', games: [{ id: 1, name: 'normal', description: '', category: '' }] },
  { raw: '[{"verse_id":"+1","name":"plus"}]', games: [{ id: 1, name: 'plus', description: '', category: '' }] },
  { raw: '[{"verse_id":" 1 ","name":"space"}]', games: [{ id: 1, name: 'space', description: '', category: '' }] },
  { raw: '[{"verse_id":true,"name":"boolean"}]', games: [{ id: 1, name: 'boolean', description: '', category: '' }] },
  { raw: '[{"verse_id":1.0,"name":"float"}]', games: [{ id: 1, name: 'float', description: '', category: '' }] },
  { raw: '[{"verse_id":100000000000000,"name":"integer"}]', games: [{ id: 100000000000000, name: 'integer', description: '', category: '' }] },
  { raw: '[{"verse_id":1e14,"name":"float scientific cast"}]', games: null },
  { raw: '[{"verse_id":"01","name":"zero"}]', games: null },
  { raw: '[{"verse_id":false,"name":"false"}]', games: null },
  { raw: '[{"verse_id":1,"name":"\u00a0"}]', games: [{ id: 1, name: '\u00a0', description: '', category: '' }] },
  { raw: '[{"verse_id":1,"name":"\\f"}]', games: [{ id: 1, name: '\f', description: '', category: '' }] },
  { raw: '[{"verse_id":1,"name":"\\u0000"}]', games: null },
  { raw: '[{"verse_id":1,"name":" \\t\\n\\r\\u000b"}]', games: null },
  { raw: '{}', games: [] },
  { raw: '[{"verse_id":1,"name":"first"},{"verse_id":"+1","name":"last"}]', games: [{ id: 1, name: 'last', description: '', category: '' }] },
];

async function fromCatalog(raw: string): Promise<unknown> {
  const catalog = new SceneCatalog({ fetch: async () => new Response(raw) });
  try { return { accepted: true, games: await catalog.getGames() }; }
  catch (error) { return { accepted: false, status: (error as any).status }; }
}

describe('source scene scalar normalization', () => {
  it.each(integerCases)('matches FILTER_VALIDATE_INT for %j', (value, expected) => {
    expect(sceneInteger(value)?.toString() ?? null).toBe(expected);
  });

  it.each(catalogCases)('preserves PHP scalar behavior for $raw', async ({ raw, games }) => {
    expect(await fromCatalog(raw)).toEqual(games === null ? { accepted: false, status: 503 } : { accepted: true, games });
  });

  it.each(['+1', ' 1 '])('accepts source pagination integer form %j', async pageCount => {
    const catalog = new SceneCatalog({ fetch: async () => new Response('[{"verse_id":1,"name":"one"}]', { headers: { 'x-pagination-page-count': pageCount } }) });
    expect(await catalog.getGames()).toHaveLength(1);
  });

  it.each(['01', '1.0', '9223372036854775808'])('rejects source-invalid pagination form %j', async pageCount => {
    const catalog = new SceneCatalog({ fetch: async () => new Response('[{"verse_id":1,"name":"one"}]', { headers: { 'x-pagination-page-count': pageCount } }) });
    await expect(catalog.getGames()).rejects.toMatchObject({ status: 503 });
  });
});

function context() {
  const state = { status: 200, type: '' };
  const ctx = { res: { status(value: number) { state.status = value; return this; }, type(value: string) { state.type = value; return this; } } } as unknown as Context;
  return { ctx, state };
}

describe('source decoded JSON forwarding cache', () => {
  it('caches a decoded 503 body and returns the next request default 200 until expiry', async () => {
    let now = 1000, calls = 0;
    const catalog = new SceneCatalog({ now: () => now, fetch: async (_input, init) => {
      calls++; expect(init?.redirect).toBe('error');
      return new Response('{"error":"unavailable"}', { status: 503 });
    } });
    const a = context(), b = context(), c = context();
    expect(await catalog.forwardCheckin(a.ctx)).toEqual({ error: 'unavailable' });
    expect(await catalog.forwardCheckin(b.ctx)).toEqual({ error: 'unavailable' });
    expect([a.state.status, b.state.status, calls]).toEqual([503, 200, 1]);
    now += 30000; await catalog.forwardCheckin(c.ctx);
    expect([c.state.status, calls]).toEqual([503, 2]);
  });

  it.each(['not JSON', '{"broken":', '{"bad":"\\ud800"}'])('does not cache source-invalid JSON %j', async raw => {
    let calls = 0;
    const catalog = new SceneCatalog({ fetch: async () => { calls++; return new Response(raw, { status: 503 }); } });
    for (let i = 0; i < 2; i++) {
      const { ctx, state } = context();
      expect(await catalog.forwardCheckin(ctx)).toBe(raw); expect(state.status).toBe(503);
    }
    expect(calls).toBe(2);
  });

  it('retains false as the source cache miss sentinel', async () => {
    let calls = 0;
    const catalog = new SceneCatalog({ fetch: async () => { calls++; return new Response('false'); } });
    expect(await catalog.forwardCheckin(context().ctx)).toBe(false);
    expect(await catalog.forwardCheckin(context().ctx)).toBe(false);
    expect(calls).toBe(2);
  });

  it('decodes empty/numeric-key objects using the same PHP array representation', async () => {
    const catalog = new SceneCatalog({ fetch: async () => new Response('{"0":{},"1":[]}') });
    expect(await catalog.forwardCheckin(context().ctx)).toEqual([[], []]);
  });
});

const sourceRoot = resolve(process.env.YII2_SOURCE_ROOT || resolve(__dirname, '../../game'));
const sourceAvailable = existsSync(resolve(sourceRoot, 'api/vendor/yiisoft/yii2/Yii.php'));
describe.skipIf(!sourceAvailable)('offline original Yii scene oracle', () => {
  it('matches source FILTER_VALIDATE_INT including exact PHP64 string boundaries', () => {
    const script = String.raw`
$input=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);
$out=[];foreach($input as $value){$id=filter_var($value,FILTER_VALIDATE_INT,['options'=>['min_range'=>1]]);$out[]=$id===false?null:(string)$id;}echo json_encode($out,JSON_THROW_ON_ERROR);
`;
    const oracle = spawnSync('php', ['-r', script], { input: JSON.stringify(integerCases.map(([value]) => value)), encoding: 'utf8', timeout: 10000 });
    expect(oracle.error).toBeUndefined(); expect(oracle.status, oracle.stderr).toBe(0);
    expect(integerCases.map(([value]) => sceneInteger(value)?.toString() ?? null)).toEqual(JSON.parse(oracle.stdout));
  });

  it('compares full games directly with the unchanged source catalog normalizer', async () => {
    const script = String.raw`
$input=json_decode(stream_get_contents(STDIN),true,512,JSON_THROW_ON_ERROR);$root=$input['root'];
require $root.'/api/vendor/autoload.php';require $root.'/api/vendor/yiisoft/yii2/Yii.php';Yii::setAlias('@app',$root.'/api');
$catalog=(new ReflectionClass(app\components\AdminGameCatalog::class))->newInstanceWithoutConstructor();$method=new ReflectionMethod($catalog,'normalize');
$out=[];foreach($input['cases'] as $raw){try{$out[]=['accepted'=>true,'games'=>$method->invoke($catalog,json_decode($raw,true,512,JSON_THROW_ON_ERROR))];}catch(Throwable $e){$out[]=['accepted'=>false,'status'=>503];}}echo json_encode($out,JSON_THROW_ON_ERROR);
`;
    const oracle = spawnSync('php', ['-r', script], { input: JSON.stringify({ root: sourceRoot, cases: catalogCases.map(({ raw }) => raw) }), encoding: 'utf8', timeout: 10000 });
    expect(oracle.error).toBeUndefined(); expect(oracle.status, oracle.stderr).toBe(0);
    const expected = JSON.parse(oracle.stdout);
    for (const [index, { raw }] of catalogCases.entries()) expect(await fromCatalog(raw), raw).toEqual(expected[index]);
  });
});
