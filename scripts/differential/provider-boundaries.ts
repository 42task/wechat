import { createCipheriv, createPublicKey, sign, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { Integrations, registerIntegrations } from '../../src/integrations/integrations';
import { ApiRouter } from '../../src/core/router';
import { errorPayload } from '../../src/core/errors';
import type { Context, Row, Services } from '../../src/core/contracts';

// CLI comparison against the original Yii components, SDK methods and action
// bodies. PHP uses Symfony MockHttpClient; Node uses an injected fetch stub.
// There is no DB, Redis, browser session, merchant account or provider network.
const sourceRoot = resolve(process.env.YII_SOURCE_ROOT || '../game');
const yiiApi = resolve(sourceRoot, 'api');
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/wechat-platform-test-keys.json'), 'utf8'));
const [platform, merchant] = fixture.platforms;
const platformPublicKey = createPublicKey(platform.privateKey).export({ type: 'spki', format: 'pem' }).toString();
const serial = 'PUB_KEY_ID_PROVIDER_PARITY';
const now = Math.floor(Date.now() / 1000);
const apiV3Key = '0123456789abcdef0123456789abcdef';
const names = Object.keys(process.env).filter(name => /^(WECHAT_|TENCENT_|COS_|SECRET_ID$|SECRET_KEY$)/.test(name));
const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
for (const name of names) delete process.env[name];

function headers(raw: string, options: { offset?: number; signature?: string; serial?: string; contentType?: string } = {}): Record<string, string> {
  const timestamp = String(now + (options.offset || 0)), nonce = 'provider-fixture-nonce';
  return { 'Content-Type': options.contentType || 'application/json', 'Wechatpay-Timestamp': timestamp, 'Wechatpay-Nonce': nonce,
    'Wechatpay-Serial': options.serial || serial, 'Wechatpay-Signature': options.signature || sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), platform.privateKey).toString('base64') };
}
function notice(event = 'TRANSACTION.SUCCESS', state = 'SUCCESS', metadata: Row = {}): string {
  const nonce = '0123456789ab', associated = 'transaction';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associated));
  const resource = { appid: 'wx-provider-fixture', mchid: '1900000001', out_trade_no: 'fixture-order', trade_state: state, out_refund_no: 'fixture-refund', refund_status: 'SUCCESS', ...metadata };
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(resource)), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ id: 'fixture-notice', event_type: event, resource_type: 'encrypt-resource', resource: { algorithm: 'AEAD_AES_256_GCM', ciphertext: encrypted.toString('base64'), nonce, associated_data: associated } });
}

type Case = { id: string; operation: string; provider?: { status?: number; raw: string; headers?: Record<string, string> }; configured?: boolean; callback?: { raw: string; headers: Record<string, string> }; version?: 'v1' | 'v2'; refund?: boolean; securityBoundary?: string; body?: Row; query?: Row };
const provider = (body: unknown) => ({ raw: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
const payment = (body: unknown, signatureOptions: Parameters<typeof headers>[1] = {}) => { const raw = JSON.stringify(body); return { raw, headers: headers(raw, signatureOptions) }; };
const callback = (raw: string, options: Parameters<typeof headers>[1] = {}) => ({ raw, headers: headers(raw, options) });
const validNotice = notice();
const refundNotice = notice('REFUND.SUCCESS');
const xmlNotice = '<xml><event_type>TRANSACTION.SUCCESS</event_type><trade_state>SUCCESS</trade_state><out_trade_no>fixture-order</out_trade_no></xml>';
const httpError = (status = 400) => ({ status, ...provider({ code: 'PARAM_ERROR', message: 'synthetic provider failure' }) });
const cases: Case[] = [
  { id: 'mini.code-sdk.success', operation: 'code-sdk', provider: provider({ openid: 'fixture-openid', unionid: 'fixture-union' }) },
  { id: 'mini.code-sdk.errcode', operation: 'code-sdk', provider: provider({ errcode: 40029, errmsg: 'invalid fixture code' }) },
  { id: 'mini.v2-login.errcode', operation: 'login-v2', provider: provider({ errcode: 40029, errmsg: 'invalid fixture code' }) },
  { id: 'mini.v2-login.missing-openid', operation: 'login-v2', provider: provider({}) },
  { id: 'mini.v1-openid.errcode', operation: 'openid-v1', provider: provider({ errcode: 40029, errmsg: 'invalid fixture code' }) },
  { id: 'mini.phone.success', operation: 'phone', provider: provider({ errcode: 0, phone_info: { phoneNumber: '19900000000', purePhoneNumber: '19900000000', countryCode: '86', watermark: { appid: 'wx-provider-fixture' } } }) },
  { id: 'mini.phone.foreign-watermark', operation: 'phone', provider: provider({ errcode: 0, phone_info: { phoneNumber: '19900000000', watermark: { appid: 'foreign-fixture-app' } } }), securityBoundary: 'Like the source, trusts metadata from the authenticated WeChat HTTPS transport without adding a watermark rule.' },
  { id: 'mini.phone.missing-phone-info', operation: 'phone', provider: provider({ errcode: 0 }) },
  { id: 'mini.phone.provider-errcode', operation: 'phone', provider: provider({ errcode: 40029, errmsg: 'invalid fixture phone code' }) },
  { id: 'pay.sdk.success', operation: 'payment-sdk', provider: payment({ trade_state: 'NOTPAY' }) },
  { id: 'pay.sdk.empty-object', operation: 'payment-sdk', provider: payment({}) },
  { id: 'pay.sdk.empty-list', operation: 'payment-sdk', provider: payment([]) },
  { id: 'pay.sdk.list', operation: 'payment-sdk', provider: payment([{ total: 100 }]) },
  { id: 'pay.sdk.empty-204', operation: 'payment-sdk', provider: { status: 204, raw: '', headers: headers('') } },
  { id: 'pay.sdk.expired-signature', operation: 'payment-sdk', provider: payment({ trade_state: 'NOTPAY' }, { offset: -600 }), securityBoundary: 'Both must reject old signatures; public exception envelopes may differ.' },
  { id: 'pay.sdk.future-signature', operation: 'payment-sdk', provider: payment({ trade_state: 'NOTPAY' }, { offset: 600 }), securityBoundary: 'Retains the current Yii SDK past-age check; future timestamps still require a valid trusted signature.' },
  { id: 'pay.sdk.invalid-signature', operation: 'payment-sdk', provider: payment({ trade_state: 'NOTPAY' }, { signature: 'invalid' }), securityBoundary: 'Do not weaken verification to align error text or status.' },
  { id: 'pay.sdk.unknown-serial', operation: 'payment-sdk', provider: payment({ trade_state: 'NOTPAY' }, { serial: 'UNKNOWN_SERIAL' }), securityBoundary: 'Both must reject untrusted verification key IDs.' },
  { id: 'pay.query.http400-unsigned', operation: 'payment-query-v1', provider: { status: 400, ...provider({ code: 'PARAM_ERROR', message: 'fixture bad request' }) }, query: { out_trade_no: 'fixture-order' } },
  { id: 'pay.query.success', operation: 'payment-query-v1', provider: payment({ trade_state: 'NOTPAY', out_trade_no: 'fixture-order' }), query: { out_trade_no: 'fixture-order' } },
  { id: 'pay.order.http400', operation: 'payment-order-v1', provider: httpError(), body: { openid: 'fixture-openid', out_trade_no: 'fixture-order', amount: 100 } },
  { id: 'pay.order.http500', operation: 'payment-order-v1', provider: httpError(500), body: { openid: 'fixture-openid', out_trade_no: 'fixture-order', amount: 100 } },
  { id: 'pay.order.missing-prepay-id', operation: 'payment-order-v1', provider: payment({ code: 'FIXTURE_ERROR', message: 'synthetic failure / 演示' }), body: { openid: 'fixture-openid', out_trade_no: 'fixture-order', amount: 100 } },
  { id: 'pay.order.zero-openid', operation: 'payment-order-v1', body: { openid: '0', out_trade_no: 'fixture-order', amount: 100 } },
  { id: 'pay.order.numeric-openid', operation: 'payment-order-v1', provider: httpError(), body: { openid: 123456, out_trade_no: 'fixture-order', amount: 100 } },
  { id: 'pay.order.zero-number', operation: 'payment-order-v1', body: { openid: 'fixture-openid', out_trade_no: '0', amount: 100 } },
  { id: 'pay.order.numeric-number', operation: 'payment-order-v1', provider: httpError(), body: { openid: 'fixture-openid', out_trade_no: 123456, amount: 100 } },
  { id: 'pay.info.wechat-configured', operation: 'wechat-info' },
  { id: 'pay.info.wechat-unconfigured', operation: 'wechat-info', configured: false },
  { id: 'pay.info.appid-configured', operation: 'payment-info' },
  { id: 'pay.info.appid-unconfigured', operation: 'payment-info', configured: false },
  { id: 'pay.callback.v1-json', operation: 'callback', callback: callback(validNotice) },
  { id: 'pay.callback.unsigned', operation: 'callback', callback: { raw: validNotice, headers: { 'Content-Type': 'application/json' } }, securityBoundary: 'Both reject unsigned callbacks. Status/exception matching must not bypass authentication.' },
  { id: 'pay.callback.future', operation: 'callback', callback: callback(validNotice, { offset: 600 }), securityBoundary: 'Retains source future signed timestamp acceptance and past-age rejection.' },
  { id: 'pay.callback.unknown-event', operation: 'callback', callback: callback(notice('MIGRATION.TEST')), securityBoundary: 'Both acknowledge ignored signed events without business queries or writes.' },
  { id: 'pay.callback.cross-endpoint-refund', operation: 'callback', callback: callback(refundNotice), securityBoundary: 'Both acknowledge a signed refund at the payment endpoint without processing it.' },
  { id: 'pay.callback.malformed-json', operation: 'callback', callback: callback('{invalid'), securityBoundary: 'Invalid signed callback bodies must not become successful notifications.' },
  { id: 'pay.callback.xml', operation: 'callback', callback: callback(xmlNotice, { contentType: 'application/xml' }), securityBoundary: 'Observe actual controller/SDK handling; do not assume the SDK XML parser makes the original controller flow successful.' },
  { id: 'pay.callback.v2-unpaid-json', operation: 'callback', version: 'v2', callback: callback(notice('TRANSACTION.SUCCESS', 'NOTPAY')) },
  { id: 'pay.callback.v1-unconfigured', operation: 'callback', configured: false, callback: callback(validNotice) },
  { id: 'pay.callback.v2-unconfigured', operation: 'callback', version: 'v2', configured: false, callback: callback(validNotice) },
  { id: 'pay.callback.refund-json', operation: 'callback', refund: true, callback: callback(refundNotice) },
  { id: 'cos.legacy-object-url-valid-key', operation: 'qcloud-object-url', query: { key: 'fixture/movie.mp4' } },
  { id: 'cos.legacy-object-url-array-key', operation: 'qcloud-object-url', query: { key: ['fixture/movie.mp4'] } },
  { id: 'cos.legacy-object-url-invalid-expires', operation: 'qcloud-object-url', query: { key: 'fixture/movie.mp4', expires: '001' } },
];
for (const version of ['v1', 'v2'] as const) {
  const refundBody = { out_trade_no: 'fixture-order', out_refund_no: 'fixture-refund', refund_amount: 50, total_amount: 100 };
  cases.push(
    { id: `pay.${version}-refund.http400`, operation: 'payment-refund', version, provider: httpError(), body: refundBody },
    { id: `pay.${version}-refund.success`, operation: 'payment-refund', version, provider: payment({ refund_id: 'fixture-id', status: 'PROCESSING', amount: { refund: 50 } }), body: refundBody },
    { id: `pay.${version}-refund.numeric-numbers`, operation: 'payment-refund', version, provider: httpError(), body: { ...refundBody, out_trade_no: 123456, out_refund_no: 234567 } },
    { id: `pay.${version}-query-refund.http400`, operation: 'payment-query-refund', version, provider: httpError(), query: { out_refund_no: 'fixture-refund' } },
    { id: `pay.${version}-query-refund.zero`, operation: 'payment-query-refund', version, query: { out_refund_no: '0' } },
    { id: `pay.${version}-query-transaction.http404`, operation: 'payment-query-transaction', version, provider: httpError(404), query: { transaction_id: '1'.repeat(28) } },
  );
  for (const field of ['out_trade_no', 'out_refund_no']) cases.push({ id: `pay.${version}-refund.zero-${field}`, operation: 'payment-refund', version, body: { ...refundBody, [field]: '0' } });
  for (const field of ['out_refund_no', 'refund_status']) cases.push({
    id: `pay.callback.${version}-refund-missing-${field}`, operation: 'callback', version, refund: true,
    callback: callback(notice('REFUND.SUCCESS', 'SUCCESS', { [field]: undefined })),
  });
  cases.push({ id: `pay.callback.${version}-refund-null-fields`, operation: 'callback', version, refund: true,
    callback: callback(notice('REFUND.SUCCESS', 'SUCCESS', { out_refund_no: null, refund_status: null })),
  });
}
for (const [field, value] of [['mchid', 'other-fixture-merchant'], ['appid', 'other-fixture-app']]) {
  const metadata = { [field]: value };
  cases.push(
    { id: `pay.callback.v1-paid-foreign-${field}`, operation: 'callback', callback: callback(notice('TRANSACTION.SUCCESS', 'SUCCESS', metadata)) },
    { id: `pay.callback.v1-refund-foreign-${field}`, operation: 'callback', refund: true, callback: callback(notice('REFUND.SUCCESS', 'SUCCESS', metadata)) },
    { id: `pay.callback.v2-unknown-foreign-${field}`, operation: 'callback', version: 'v2', callback: callback(notice('MIGRATION.TEST', 'SUCCESS', metadata)) },
    { id: `pay.callback.v2-cross-refund-foreign-${field}`, operation: 'callback', version: 'v2', callback: callback(notice('REFUND.SUCCESS', 'SUCCESS', metadata)) },
  );
}

async function nodeResult(test: Case) {
  const calls: Array<{ method: string; path: string }> = [];
  const api = new Integrations({ ...(test.configured === false ? {} : {
    appId: 'wx-provider-fixture', appSecret: 'provider-fixture-secret', mchId: '1900000001', serialNo: new X509Certificate(merchant.certificate).serialNumber,
    privateKey: merchant.privateKey, apiV3Key, platformKeyId: serial, platformKeys: { [serial]: platformPublicKey },
  }), now: () => now, fetch: async (url, options) => {
    const target = new URL(String(url)); calls.push({ method: options?.method || 'GET', path: target.pathname });
    if (target.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'synthetic-local-token', expires_in: 7200 });
    return new Response(test.provider?.status === 204 ? null : test.provider?.raw ?? '{}', { status: test.provider?.status || 200, headers: test.provider?.headers || { 'Content-Type': 'application/json' } });
  } });
  const user: Row = { id: 1, tel: null, nickname: 'Fixture', avatar: null, role: 'user', openid: 'fixture-openid', unionid: 'fixture-union' };
  const db = { one: async () => { throw Error('Unexpected database lookup in provider-only fixture'); }, update: async (_table: string, _id: unknown, patch: Row) => Object.assign(user, patch) };
  const auth = { bearer: async () => user, role: async (row: Row) => row };
  const router = new ApiRouter(); registerIntegrations(router, { db, auth, integrations: api } as unknown as Services);
  const res = { statusCode: 200, setHeader() {}, status(code: number) { this.statusCode = code; return this; } };
  try {
    let body: unknown;
    if (test.operation === 'code-sdk') body = await api.codeSession('synthetic-code');
    else if (test.operation === 'payment-sdk') body = await api.payment('GET', '/v3/pay/transactions/out-trade-no/fixture-order');
    else {
      const version = test.version || 'v1';
      const path = { 'login-v2': '/v2/site/login', 'openid-v1': '/v1/we-chat/openid', phone: '/v2/wechat/bind-phone', 'payment-query-v1': '/v1/wechat-pay/wxpay-query-order-by-out-trade-no', 'payment-order-v1': '/v1/wechat-pay/wxpay-order', 'payment-refund': `/${version}/wechat-pay/wxpay-refund`, 'payment-query-refund': `/${version}/wechat-pay/wxpay-query-refund`, 'payment-query-transaction': `/${version}/wechat-pay/wxpay-query-order-by-transaction-id`, 'wechat-info': '/v1/we-chat/info', 'payment-info': '/v1/wechat-pay/info', 'qcloud-object-url': '/v1/q-cloud/object-url', callback: `/${version}/wechat-pay/${test.refund ? 'refund-notify' : 'notify'}` }[test.operation];
      if (!path) throw Error('Unknown Node provider operation');
      const method = ['payment-query-v1', 'payment-query-refund', 'payment-query-transaction', 'wechat-info', 'payment-info', 'qcloud-object-url'].includes(test.operation) ? 'GET' : 'POST';
      const route = router.match(method, path)!;
      body = await route.route.handler({ req: { method, path, protocol: 'https', get: () => 'provider.fixture.invalid', headers: test.callback?.headers || {}, rawBody: Buffer.from(test.callback?.raw || '') }, res, body: test.body || { code: 'synthetic-code' }, query: test.query || {}, params: route.params } as unknown as Context);
    }
    return { result: { status: res.statusCode, body: JSON.parse(JSON.stringify(body)) }, transportCalls: calls };
  } catch (error) { return { result: errorPayload(error), transportCalls: calls }; }
}

function safe(value: any): any {
  if (Array.isArray(value)) return value.map(safe);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.replace(/("(?:session_key|access_token)"\s*:\s*")[^"]*/g, '$1[redacted]') : value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, /^(?:token|access_token|session_key|privateKey|platformPublicKey)$/i.test(name) ? '[redacted]' : safe(item)]));
}

async function main() {
  const results = [];
  try {
    for (const test of cases) {
      const php = spawnSync('php', [resolve('scripts/differential/provider-oracle.php'), yiiApi], {
        input: JSON.stringify({ ...test, merchant, platformPublicKey }), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      });
      let yii: any;
      try { yii = JSON.parse(php.stdout); }
      catch { throw new Error(`PHP provider oracle failed for ${test.id}: ${php.stderr.slice(0, 500)}`); }
      const node = await nodeResult(test);
      // PHP's injected AccessToken already supplies a synthetic token; Node's
      // local stable_token fixture is the only intentional transport extra.
      const transportEqual = isDeepStrictEqual(yii.transportCalls, node.transportCalls.filter(call => call.path !== '/cgi-bin/stable_token'));
      const equal = isDeepStrictEqual(yii.result, node.result) && transportEqual;
      const row = { id: test.id, operation: test.operation, equal, transportEqual, ...(test.securityBoundary ? { securityBoundary: test.securityBoundary } : {}), yii, node };
      results.push(safe(row)); console.log(`${equal ? 'MATCH' : 'DIFFERENT'} ${test.id}`);
    }
  } finally { Object.assign(process.env, prior); }
  const report = { generatedAt: new Date().toISOString(), total: results.length, matched: results.filter(row => row.equal).length, differences: results.filter(row => !row.equal).length,
    scope: 'Original Yii component/SDK/action bodies vs Node injected provider boundaries, no database/Redis and no real provider transport.',
    notExecuted: ['Tencent STS is covered separately by sts-boundaries.json with the original SDK and injected transport; missing-credential remote errors are not fabricated.', 'Full v2 paid callback DB requery/unlock is excluded; v2 callback fixtures stop before that branch.'], results };
  writeFileSync(resolve('runtime/parity-validation/provider-boundaries.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ suite: 'provider-boundaries', total: report.total, matched: report.matched, differences: report.differences }));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
