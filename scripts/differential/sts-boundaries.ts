import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { Integrations, registerIntegrations } from '../../src/integrations/integrations';
import { ApiRouter } from '../../src/core/router';
import { errorPayload } from '../../src/core/errors';
import type { Context, Row, Services } from '../../src/core/contracts';

// Uses current Yii controller bodies and its real Tencent SDK. Only the
// internally constructed transport is injected with Guzzle/Fetch test handlers.
const yiiApi = resolve(process.env.YII_SOURCE_ROOT || '../game', 'api');
const now = Math.floor(Date.now() / 1000);
const success = { Response: { Credentials: { Token: 'synthetic-token', TmpSecretId: 'synthetic-id', TmpSecretKey: 'synthetic-key' }, ExpiredTime: now + 1800, Expiration: new Date((now + 1800) * 1000).toISOString(), RequestId: 'synthetic-request' } };
type Test = { id: string; version: 'v1' | 'v2'; operation?: 'token' | 'store'; arguments?: string[]; query?: Row; provider: { status?: number; body: unknown } };
const tests: Test[] = [
  { id: 'sts.v1.caller-bucket-default-region', version: 'v1', arguments: ['caller-1250001234'], query: { bucket: 'caller-1250001234' }, provider: { body: success } },
  { id: 'sts.v1.caller-bucket-and-region', version: 'v1', arguments: ['other-1250002345', 'ap-beijing'], query: { bucket: 'other-1250002345', region: 'ap-beijing' }, provider: { body: success } },
  { id: 'sts.v1.provider-validates-bucket', version: 'v1', arguments: ['plain'], query: { bucket: 'plain' }, provider: { body: success } },
  { id: 'sts.v1.php-urlencode-policy', version: 'v1', arguments: ['caller space-1250001234'], query: { bucket: 'caller space-1250001234' }, provider: { body: success } },
  { id: 'sts.v2.ignores-storage-overrides', version: 'v2', query: { bucket: 'ignored-1250002345', region: 'ap-beijing' }, provider: { body: success } },
  { id: 'sts.v1.store-configured', version: 'v1', operation: 'store', provider: { body: success } },
  { id: 'sts.v2.store-configured', version: 'v2', operation: 'store', provider: { body: success } },
  { id: 'sts.v1.provider-error', version: 'v1', arguments: ['caller-1250001234'], query: { bucket: 'caller-1250001234' }, provider: { body: { Response: { Error: { Code: 'AuthFailure.InvalidSecretId', Message: 'Synthetic provider denied fixture credentials.' }, RequestId: 'synthetic-request' } } } },
  { id: 'sts.v2.provider-http-error', version: 'v2', provider: { status: 403, body: { Response: { Error: { Code: 'Forbidden', Message: 'Synthetic transport status fixture.' } } } } },
];

async function node(test: Test) {
  const transportCalls: Row[] = [];
  const api = new Integrations({ secretId: 'synthetic-sts-id', secretKey: 'synthetic-sts-key', bucket: 'configured-1250000000', region: 'ap-shanghai', now: () => now, fetch: async (url, options) => {
    const target = new URL(String(url));
    if (target.hostname !== 'sts.tencentcloudapi.com') throw Error('Unexpected provider target');
    const sentHeaders = new Headers(options?.headers);
    const headers = Object.fromEntries(['Content-Type', 'X-TC-Action', 'X-TC-Version', 'X-TC-Region'].filter(name => sentHeaders.has(name)).map(name => [name, sentHeaders.get(name)]));
    transportCalls.push({ method: options?.method || 'GET', path: target.pathname, headers, body: JSON.parse(String(options?.body)) });
    return Response.json(test.provider.body, { status: test.provider.status || 200 });
  } });
  const router = new ApiRouter();
  registerIntegrations(router, { integrations: api } as Services);
  try {
    const route = router.match('GET', `/${test.version}/tencent-cloud/${test.operation || 'token'}`)!;
    const body = await route.route.handler({ query: test.query || {}, body: {}, params: {}, req: { headers: {} }, res: { setHeader() {} } } as unknown as Context);
    return { result: { status: 200, body }, transportCalls };
  } catch (error) { return { result: errorPayload(error), transportCalls }; }
}
function normalized(value: any): any {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'startTime' ? '[current-second]' : normalized(item)]));
}
function safe(value: any): any {
  if (Array.isArray(value)) return value.map(safe);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['Token', 'TmpSecretKey', 'token', 'tmpSecretKey'].includes(key) ? '[synthetic-redacted]' : safe(item)]));
}
async function main() {
  const results = [];
  for (const test of tests) {
    const php = spawnSync('php', [resolve('scripts/differential/sts-oracle.php'), yiiApi], { input: JSON.stringify(test), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    let yii: any;
    try { yii = JSON.parse(php.stdout); } catch { throw Error(`PHP STS oracle failed: ${php.stderr.slice(0, 500)}`); }
    const actual = await node(test);
    const responseEqual = isDeepStrictEqual(normalized(yii.result), normalized(actual.result));
    const requestEqual = isDeepStrictEqual(yii.transportCalls, actual.transportCalls);
    const equal = responseEqual && requestEqual;
    results.push(safe({ id: test.id, equal, responseEqual, requestEqual, yii, node: actual }));
    console.log(`${equal ? 'MATCH' : 'DIFFERENT'} ${test.id}`);
  }
  const report = { generatedAt: new Date().toISOString(), scope: 'Current Yii controller bodies + actual Tencent SDK with injected Guzzle transport vs Node Fetch, synthetic keys/responses only. No SQL/Redis/provider network.', total: results.length, matched: results.filter(row => row.equal).length, differences: results.filter(row => !row.equal).length,
    normalization: 'Only store.startTime current-second fluctuation is normalized; request bodies/Policy/header values are exact.',
    notExecuted: ['No real temporary credentials were issued. Vendor acceptance of the legacy principal/actions policy and actual account permissions require provider acceptance testing.', 'Missing/unconfigured credential errors are not fabricated from historical remote responses.'], results };
  writeFileSync(resolve('runtime/parity-validation/sts-boundaries.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ suite: 'sts-boundaries', total: report.total, matched: report.matched, differences: report.differences }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
