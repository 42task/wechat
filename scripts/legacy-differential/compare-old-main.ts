/**
 * Offline differential observations against the frozen deployed old main.
 * Run: node --import tsx scripts/legacy-differential/compare-old-main.ts
 * Requires disposable MySQL at 127.0.0.1:33368. Creates a random new fixture
 * database, resets only its own tables, then drops and verifies its absence.
 *
 * Exit 0: the exercised comparisons match; exit 1: actual incompatibilities;
 * exit 2: an oracle, isolation, provenance, or positive-control failure.
 * An expected incompatibility is still an incompatibility, never a parity pass.
 * This script does not authorize restoring dangerous old behavior.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, sign, verify } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import jwt from 'jsonwebtoken';
import mysql, { type Connection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { AuthService } from '../../src/core/auth';
import type { Context, Row, Services } from '../../src/core/contracts';
import { errorPayload } from '../../src/core/errors';
import { ApiRouter } from '../../src/core/router';
import { Integrations, registerIntegrations } from '../../src/integrations/integrations';
import { registerV2 } from '../../src/v2';

const repository = resolve(__dirname, '../..');
const runtime = resolve(repository, 'runtime/legacy-main-source-20261112');
const snapshot = resolve(runtime, 'source/api');
const vendor = resolve(repository, '../game/api/vendor');
const oraclePath = resolve(__dirname, 'old-main-oracle.php');
const outputPath = resolve(runtime, 'comparison.json');
const sourceCommit = 'c4e088adc7ba17bd5bb640ac31178a122906e002';
const fixedIso = '2026-11-12T00:00:00.000Z';
const fixedMs = Date.parse(fixedIso);
const fixedSeconds = fixedMs / 1000;
const origin = 'https://old-main.fixture.invalid';
const syntheticJwtKey = 'synthetic-local-old-main-key-32-bytes-minimum';
const fixtureDatabase = `parity_legacy_compare_${randomBytes(12).toString('hex')}`;
const local = { host: '127.0.0.1', port: 33368, user: 'root', password: 'wechat-local-test' };
const user: Row = { id: 7, openid: 'fixture-payer', unionid: 'fixture-union', role: 'user' };
const fileColumns = ['id', 'unionid', 'key', 'type', 'md5', 'size', 'bucket', 'created_at', 'unlocked', 'title', 'user_id'];

type HttpResult = { status: number; body: unknown };
type SourceCall = { path: string; sha256: string; [key: string]: unknown };
type OracleResult = {
  sourceCommit: string; result: HttpResult; transportCalls: Row[]; utilityCalls: Row[];
  persistenceCalls: Row[]; executedSource: SourceCall[]; runtime: Row; isolation: Row;
};
type Scenario = {
  id: string; purpose: string; input: Row; method: string; path: string;
  files?: Row[]; binding?: Row; modernFilePrice?: boolean; safety?: string;
};

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);

// No .env is loaded. Clear service configuration before constructing application
// adapters, including Integrations' legacy environment fallback. Keep only PATH
// for local executables. Child PHP also receives this explicit clean environment.
const executablePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
for (const name of Object.keys(process.env)) delete process.env[name];
process.env.PATH = executablePath;
process.env.TZ = 'Asia/Shanghai';
process.env.NODE_ENV = 'test';
process.env.YII_DEBUG = 'true';
const childEnvironment = { PATH: executablePath, TZ: 'Asia/Shanghai', TMPDIR: '/tmp' };

// The application reservation path uses new Date(), without an injectable clock.
// Freeze the isolated script's clock as well as the adapters' explicit clocks.
// No timestamps are removed from comparisons or replaced after execution.
const RealDate = Date;
class FixtureDate extends RealDate {
  constructor(value?: string | number) { super(value === undefined ? fixedMs : value); }
  static now(): number { return fixedMs; }
}
globalThis.Date = FixtureDate as DateConstructor;
globalThis.fetch = async () => { throw new Error('Real network access is forbidden by this script'); };

let manifest: Row;
let manifestHashes: Map<string, string>;
let syntheticPlatform: { certificate: string; privateKey: string };

function guardTarget(): void {
  if (local.host !== '127.0.0.1' || local.port !== 33368 || !/^parity_legacy_compare_[0-9a-f]{24}$/.test(fixtureDatabase)) {
    throw new Error('Refusing any target other than this invocation\'s isolated local fixture database');
  }
  if (process.argv.length !== 2 || resolve(process.cwd()) !== repository) {
    throw new Error('Run from the repository root without target or configuration arguments');
  }
}

async function rows(connection: Connection, sql: string, params: any[] = []): Promise<Row[]> {
  return (await connection.query<RowDataPacket[]>(sql, params))[0];
}

function oracle(input: Row): OracleResult {
  const stdout = execFileSync('php', [oraclePath, snapshot, vendor], {
    input: JSON.stringify(input), encoding: 'utf8', env: childEnvironment,
    cwd: repository, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(stdout) as OracleResult;
  if (result.sourceCommit !== sourceCommit) throw new Error('Oracle returned the wrong source commit');
  for (const executed of result.executedSource) {
    const relative = `api/${executed.path}`;
    if (manifestHashes.get(relative) !== executed.sha256 || sha256(resolve(snapshot, executed.path)) !== executed.sha256) {
      throw new Error(`Oracle source evidence differs from frozen manifest: ${relative}`);
    }
  }
  if (result.isolation.applicationConfigLoaded !== false) throw new Error('Oracle loaded application configuration');
  return result;
}

async function fixtureState(connection: Connection, files: Row[], includePrice: boolean, binding?: Row) {
  guardTarget();
  if ((await rows(connection, 'SELECT DATABASE() AS name'))[0].name !== fixtureDatabase) throw new Error('Wrong active fixture database');
  const calls: Row[] = [];
  // Only this newly created database is reset between scenarios. These tables
  // model the exercised contract, not a claim to reproduce all deployed DDL.
  for (const table of ['file_payment_order', 'file', 'control', 'user']) await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
  for (const sql of [
    'CREATE TABLE `user` (id INT PRIMARY KEY, openid VARCHAR(255), unionid VARCHAR(255), role VARCHAR(32), tel VARCHAR(255))',
    'CREATE TABLE control (id INT PRIMARY KEY, user_id INT)',
    `CREATE TABLE file (id INT PRIMARY KEY, unionid VARCHAR(255), \`key\` VARCHAR(255), type VARCHAR(255), md5 VARCHAR(255),
      size INT, bucket VARCHAR(255), created_at DATETIME NULL, unlocked INT, title VARCHAR(255), user_id INT${includePrice ? ', price INT' : ''})`,
    'CREATE TABLE file_payment_order (out_trade_no VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, user_id INT NOT NULL, file_id INT NOT NULL, amount INT NOT NULL, created_at DATETIME NOT NULL)',
  ]) await connection.query(sql);
  await connection.query('INSERT INTO `user` VALUES (?,?,?,?,?)', [user.id, user.openid, user.unionid, user.role, null]);
  const columns = [...fileColumns, ...(includePrice ? ['price'] : [])];
  const insert = `INSERT INTO file (${columns.map(name => `\`${name}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  for (const file of files) await connection.query(insert, columns.map(name => file[name] ?? null));
  if (binding) await connection.query('INSERT INTO file_payment_order VALUES (?,?,?,?,?)', [
    binding.out_trade_no, binding.user_id, binding.file_id, binding.amount, '2026-11-12 08:00:00',
  ]);
  const db = {
    async one(sql: string, params: any[] = []) {
      calls.push({ operation: 'one', sql, params: clone(params) });
      return (await rows(connection, sql, params))[0] ?? null;
    },
    async query(sql: string, params: any[] = []) {
      calls.push({ operation: 'query', sql, params: clone(params) });
      return rows(connection, sql, params);
    },
    async execute(sql: string, params: any[] = []) {
      calls.push({ operation: 'execute', sql, params: clone(params) });
      const [result] = await connection.query<ResultSetHeader>(sql, params);
      return { affectedRows: result.affectedRows, insertId: result.insertId };
    },
  };
  const initialState = { files: await rows(connection, 'SELECT * FROM file ORDER BY id'),
    orders: await rows(connection, 'SELECT * FROM file_payment_order ORDER BY out_trade_no') };
  return { db, calls, initialState };
}

function providerRequests(calls: Row[]): Row[] {
  return calls.map(call => {
    // PHP SDK records relative paths; Node transport records absolute URLs.
    // Canonicalize only their equivalent path/query representation, not payloads.
    const url = new URL(call.path.replace(/^\//, ''), 'https://synthetic-provider.invalid/');
    const query = Object.fromEntries(url.searchParams);
    const options = { ...call.options };
    const mergedQuery = { ...query, ...options.query };
    delete options.query;
    return { method: call.method, path: url.pathname, ...options,
      ...(Object.keys(mergedQuery).length ? { query: mergedQuery } : {}) };
  });
}

function comparable(result: HttpResult, transports: Row[], mutations: Row[]): Row {
  const response = clone(result);
  const body = response.body as Row;
  // PHP's oracle deliberately stubs buildMiniAppConfig signing. Node executes
  // real signing with PUBLIC TEST keys and is independently verified below.
  // This one documented synthetic signature is the only value normalization.
  if (body?.code === 0 && body.data?.package && typeof body.data.paySign === 'string') {
    body.data.paySign = '<synthetic-payment-signature>';
  }
  return { response, providerRequests: providerRequests(transports), persistenceMutations: mutations };
}

async function nodeRoute(connection: Connection, scenario: Scenario) {
  const state = await fixtureState(connection, scenario.files ?? scenario.input.files ?? [], scenario.modernFilePrice === true, scenario.binding);
  const transportCalls: Row[] = [];
  const wireCalls: Row[] = [];
  const authenticatedIdentities: Row[] = [];
  const payment = new Integrations({
    appId: 'wx-synthetic-old-main', mchId: '1900000001', serialNo: 'synthetic-merchant-key',
    privateKey: syntheticPlatform.privateKey, platformKeys: { 'synthetic-platform-key': syntheticPlatform.certificate },
    now: () => fixedSeconds, nonce: () => 'synthetic-local-nonce',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== 'https://api.mch.weixin.qq.com') throw new Error('Unexpected synthetic transport destination');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const query = Object.fromEntries(url.searchParams);
      transportCalls.push({ method, path: url.pathname,
        options: { ...(body !== undefined ? { json: body } : {}), ...(Object.keys(query).length ? { query } : {}) } });
      wireCalls.push({ url: url.toString(), method, body: body ?? null,
        headers: Object.fromEntries(new Headers(init?.headers)) });
      const raw = JSON.stringify(scenario.input.provider?.body ?? { prepay_id: 'synthetic-prepay-id' });
      const nonce = 'synthetic-provider-response-nonce';
      return new Response(raw, { status: 200, headers: {
        'wechatpay-serial': 'synthetic-platform-key', 'wechatpay-timestamp': String(fixedSeconds),
        'wechatpay-nonce': nonce,
        'wechatpay-signature': sign('RSA-SHA256', Buffer.from(`${fixedSeconds}\n${nonce}\n${raw}\n`), syntheticPlatform.privateKey).toString('base64'),
      } });
    },
  });
  const router = new ApiRouter();
  const services = { db: state.db, integrations: payment, auth: {
    bearer: async (_ctx: Context, domain: string) => {
      authenticatedIdentities.push({ domain, user: clone(user) });
      return clone(user);
    },
  } } as unknown as Services;
  registerV2(router, services);
  registerIntegrations(router, services);
  let status = 200;
  const headers: Row = {};
  const response = {
    setHeader(name: string, value: unknown) { headers[name] = value; },
    status(value: number) { status = value; return response; },
  };
  const match = router.match(scenario.method, scenario.path);
  if (!match) throw new Error(`Current Node route is missing: ${scenario.method} ${scenario.path}`);
  let result: HttpResult;
  try {
    const context = { body: clone(scenario.input.body ?? {}), query: clone(scenario.input.query ?? {}), params: match.params,
      req: { method: scenario.method, path: scenario.path, protocol: 'https', headers: {}, get: () => 'old-main.fixture.invalid' },
      res: response } as unknown as Context;
    result = { status, body: await match.route.handler(context) };
    result.status = status;
  } catch (error) { result = errorPayload(error); }
  const data = (result.body as Row)?.data;
  let syntheticPaymentSignatureValid: boolean | null = null;
  if (data?.paySign) {
    syntheticPaymentSignatureValid = verify('RSA-SHA256',
      Buffer.from(`${data.appId}\n${data.timeStamp}\n${data.nonceStr}\n${data.package}\n`),
      syntheticPlatform.certificate, Buffer.from(data.paySign, 'base64'));
    if (!syntheticPaymentSignatureValid) throw new Error('Synthetic Node mini-app signature failed verification');
  }
  const finalState = {
    files: await rows(connection, 'SELECT * FROM file ORDER BY id'),
    orders: await rows(connection, 'SELECT * FROM file_payment_order ORDER BY out_trade_no'),
  };
  return { result, headers, transportCalls, wireCalls, persistenceCalls: state.calls, initialState: state.initialState, finalState,
    authenticatedIdentities, syntheticPaymentSignatureValid };
}

function differences(left: unknown, right: unknown, path = '$'): string[] {
  if (isDeepStrictEqual(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const paths = left.length === right.length ? [] : [`${path}.length`];
    for (let index = 0; index < Math.min(left.length, right.length); index++) paths.push(...differences(left[index], right[index], `${path}[${index}]`));
    return paths;
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].flatMap(key => differences((left as Row)[key], (right as Row)[key], `${path}.${key}`));
  }
  return [path];
}

const ownedFile = { id: 12, unionid: user.unionid, key: 'synthetic/clip.mp4', user_id: user.id, unlocked: 0, price: 250 };
const orderBody = { openid: user.openid, out_trade_no: '1794441600123123456', amount: 250, description: 'AR打卡服务:clip.mp4' };
const oldSuccess = { appid: 'wx-synthetic-old-main', mchid: '1900000001', out_trade_no: orderBody.out_trade_no,
  trade_state: 'SUCCESS', trade_state_desc: '支付成功', payer: { openid: user.openid }, amount: { total: 250, currency: 'CNY' } };
const ownedRows = Array.from({ length: 25 }, (_, index) => ({
  id: index + 1, unionid: user.unionid, key: `synthetic/file-${index + 1}.mp4`, user_id: user.id, unlocked: 0,
}));
const mixedRows = [ownedRows[0], { id: 2, unionid: 'prefix-fixture-union-suffix', key: 'synthetic/another-owner.mp4', user_id: 8, unlocked: 0 }];
const list = (id: string, files: Row[], query: Row, purpose: string, safety?: string): Scenario => ({
  id, purpose, safety, method: 'GET', path: '/v2/files/list', input: { operation: 'file-list', files, query },
});
const scenarios: Scenario[] = [
  { id: 'legacy-order-without-file-id', purpose: 'Actual v0 request fields contain no authoritative file identifier.',
    method: 'POST', path: '/v2/wechat-pay/wxpay-order', input: { operation: 'payment-order-v2', body: orderBody },
    files: [ownedFile], modernFilePrice: true,
    safety: 'Observation only: source trusts client amount and payer. Do not infer a file or grant access from amount, description or order timestamp.' },
  { id: 'modern-valid-file-id-order', purpose: 'Modern positive request succeeds, but reservation, attachment and callback target differ from oldmain.',
    method: 'POST', path: '/v2/wechat-pay/wxpay-order', input: { operation: 'payment-order-v2', body: { ...orderBody, file_id: ownedFile.id } },
    files: [ownedFile], modernFilePrice: true },
  { id: 'legacy-success-without-local-binding', purpose: 'Historical provider SUCCESS cannot satisfy current local reservation ownership.',
    method: 'GET', path: '/v2/wechat-pay/wxpay-query-order-by-out-trade-no',
    input: { operation: 'payment-query-v2', query: { out_trade_no: orderBody.out_trade_no }, provider: { body: oldSuccess } },
    files: [ownedFile], modernFilePrice: true },
  { id: 'legacy-success-binding-without-attach', purpose: 'Even a synthetic local reservation does not supply the missing provider attachment.',
    method: 'GET', path: '/v2/wechat-pay/wxpay-query-order-by-out-trade-no',
    input: { operation: 'payment-query-v2', query: { out_trade_no: orderBody.out_trade_no }, provider: { body: oldSuccess } },
    files: [ownedFile], modernFilePrice: true,
    binding: { out_trade_no: orderBody.out_trade_no, user_id: user.id, file_id: ownedFile.id, amount: 250 },
    safety: 'The reservation is test setup, not an authorized migration of historical payment/file associations.' },
  list('file-list-empty-bare-array', [], { unionid: user.unionid }, 'Both implementations serialize no matches as a bare empty array.'),
  list('file-list-one-owned-row', [ownedRows[0]], { unionid: user.unionid }, 'A single exact-owner old-schema row has the same bare-array projection.'),
  list('file-list-default-pagination', ownedRows, { unionid: user.unionid }, 'Old default first page versus Node complete owner list ordered descending.'),
  list('file-list-second-page', ownedRows, { unionid: user.unionid, page: 2 }, 'Old page two versus Node list ignoring pagination.'),
  list('file-list-custom-page-size', ownedRows, { unionid: user.unionid, 'per-page': 5 }, 'Old provider page-size input versus Node full list.'),
  list('file-list-like-owner-boundary', mixedRows, { unionid: user.unionid }, 'Source LIKE unionid includes a substring match belonging to another owner.',
    'Dangerous source access behavior is observed only. It is not a recommendation to weaken authenticated owner checks.'),
  list('file-list-other-owner-query', mixedRows, { unionid: 'prefix-fixture-union-suffix' }, 'Caller-supplied unionid and authenticated owner produce different records.',
    'Observation only: reproducing arbitrary-union queries requires an access/security decision.'),
];

async function main(): Promise<void> {
  const results: Row[] = [];
  const report: Row = { schemaVersion: 1, generatedAt: fixedIso, results,
    target: { host: local.host, port: local.port, database: fixtureDatabase },
    cleanup: { created: false, dropped: false, verifiedAbsent: false } };
  let connection: Connection | undefined;
  let created = false;
  let failure: unknown;
  try {
  guardTarget();
  manifest = JSON.parse(readFileSync(resolve(runtime, 'manifest.json'), 'utf8'));
  if (manifest.commit !== sourceCommit) throw new Error('Unexpected frozen source commit');
  manifestHashes = new Map<string, string>(manifest.files.map((entry: Row) => [entry.path, entry.sha256]));
  syntheticPlatform = JSON.parse(readFileSync(resolve(repository, 'tests/fixtures/wechat-platform-test-keys.json'), 'utf8')).platforms[0];
  connection = await mysql.createConnection({ ...local, dateStrings: true, supportBigNumbers: true,
    bigNumberStrings: true, charset: 'utf8mb4', timezone: '+08:00', connectTimeout: 5000, multipleStatements: false });
  report.mysql = (await rows(connection, 'SELECT VERSION() AS version, @@version_comment AS distribution, @@sql_mode AS sqlMode'))[0];
  guardTarget();
  // No IF NOT EXISTS: a collision must never authorize reuse or later DROP.
  await connection.query(`CREATE DATABASE \`${fixtureDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  created = true;
  report.cleanup.created = true;
  await connection.changeUser({ database: fixtureDatabase });
  for (const scenario of scenarios) {
    const source = oracle(scenario.input);
    const target = await nodeRoute(connection, scenario);
    const sourceComparable = comparable(source.result, source.transportCalls, []);
    const targetComparable = comparable(target.result, target.transportCalls,
      target.persistenceCalls.filter(call => call.operation === 'execute'));
    const changedPaths = differences(sourceComparable, targetComparable);
    results.push({ id: scenario.id, purpose: scenario.purpose, safety: scenario.safety ?? null,
      finding: changedPaths.length ? 'incompatible' : 'compatible', changedPaths,
      input: scenario.input, nodeFixture: { authenticatedUser: user, files: scenario.files ?? scenario.input.files ?? [],
        binding: scenario.binding ?? null, modernFilePrice: scenario.modernFilePrice === true },
      comparable: { source: sourceComparable, node: targetComparable }, source, node: target });
  }

  const sourceToken = oracle({ operation: 'user-token', userId: user.id, now: fixedIso });
  const tokenBody = sourceToken.result.body as Row;
  if (sourceToken.result.status !== 200 || !tokenBody.accessToken || tokenBody.claims.identityDomain !== undefined) {
    throw new Error('Frozen source did not emit the expected domainless synthetic JWT');
  }
  const tokenState = await fixtureState(connection, [], false);
  const auth = new AuthService(tokenState.db as any, { jwtKey: syntheticJwtKey, now: () => fixedMs });
  const modernPair = auth.issue(user, 'v2-user', origin);
  const modernClaims = jwt.decode(modernPair.accessToken);
  const verifyToken = async (token: string): Promise<HttpResult> => {
    try { return { status: 200, body: await auth.verifyToken(token, 'v2-user') }; }
    catch (error) { return errorPayload(error); }
  };
  const legacyConsumption = await verifyToken(tokenBody.accessToken);
  const modernConsumption = await verifyToken(modernPair.accessToken);
  const sourceTokenRejectedByNode = legacyConsumption.status !== 200;
  if (legacyConsumption.status !== 401 || modernConsumption.status !== 200) throw new Error('JWT consumption control changed unexpectedly');
  const claimChanges = differences(tokenBody.claims, modernClaims, '$.claims');
  results.push({ id: 'jwt-domainless-source-versus-modern-domain',
    purpose: 'Compare actual fixed-time token claims and exercise current Node consumption of both actual signed tokens.',
    finding: claimChanges.length || sourceTokenRejectedByNode ? 'incompatible' : 'compatible',
    changedPaths: [...claimChanges, ...(sourceTokenRejectedByNode ? ['$.nodeConsumptionOfSourceToken.status'] : [])],
    safety: 'No old bearer validator is simulated. The source operation issues a token; actual Node verifies it. Do not infer that accepting domainless uid claims safely distinguishes v1 player and v2 user identities.',
    source: sourceToken, node: { pair: modernPair, claims: modernClaims, sourceTokenConsumption: legacyConsumption,
      modernTokenConsumption: modernConsumption, persistenceCalls: tokenState.calls },
  });

  const modernOrder = results.find(row => row.id === 'modern-valid-file-id-order')!;
  const controls = [
    { id: 'modern-order-still-succeeds', passed: modernOrder.node.result.status === 200 && modernOrder.node.result.body.code === 0 },
    { id: 'modern-order-creates-immutable-reservation', passed: modernOrder.node.finalState.orders.length === 1 },
    { id: 'modern-payment-signature-verifies', passed: modernOrder.node.syntheticPaymentSignatureValid === true },
    { id: 'modern-domain-token-verifies-at-fixed-time', passed: modernConsumption.status === 200 },
  ];
  if (controls.some(control => !control.passed)) throw new Error('A modern positive control failed');
  const counts = { compared: results.length, compatible: results.filter(row => row.finding === 'compatible').length,
    incompatible: results.filter(row => row.finding === 'incompatible').length, positiveControls: controls.length };
  const nodeSourceFiles = ['src/core/router.ts', 'src/core/auth.ts', 'src/core/errors.ts', 'src/core/php.ts',
    'src/v2/index.ts', 'src/v2/resources.ts', 'src/v2/file-service.ts', 'src/integrations/integrations.ts', 'src/integrations/routes.ts'];
  Object.assign(report, {
    counts, controls,
    conclusion: counts.incompatible ? 'Current Node is incompatible with the exercised deployed-old-main contracts.' : 'Only the exercised local comparisons matched.',
    isolation: { environment: 'Cleared before constructing adapters; only executable PATH and synthetic runtime flags retained.',
      provider: 'Injected signed in-memory fetch; global fetch throws; no external provider calls.',
      database: 'Disposable local MySQL only, hardcoded 127.0.0.1:33368; random invocation-owned database with synthetic rows, per-scenario reset, finally DROP and verified absence. No Redis.',
      php: 'Frozen source oracle; no application config; original dependencies checked by oracle.',
      routeAuthentication: 'Payment/list action comparisons supply the same fixed authenticated user at the adapter boundary. JWT consumption is tested separately with actual AuthService.',
      clock: fixedIso },
    comparisonBoundary: [
      'Compare status/body, canonical provider payloads and persistence mutations; retain all raw recorder calls.',
      'PHP query-builder plans and Node SQL read strings are retained rather than falsely compared as the same language; list fixture outputs exercise selection, pagination, order and owner boundaries.',
      'Only synthetic mini-app paySign is normalized. Node synthetic signatures are verified independently; timestamps, nonce, payload, attach, callback URL, claims and response differences remain visible.',
      'JWT comparison uses all decoded claims; original signed tokens and actual Node consumption outcomes are retained. Old bearer middleware was not executed.',
      'This is not full HTTP middleware, deployed MySQL collation, SDK signing, real provider, callback, hardware or production parity.',
      'Dangerous legacy cases are observations only and do not authorize importing purchases, inferring a file, trusting a client price, or relaxing runtime security.',
    ],
    provenance: {
      source: { commit: manifest.commit, tree: manifest.tree, archiveSha256: manifest.archiveSha256, fileCount: manifest.fileCount,
        manifestPath: 'runtime/legacy-main-source-20261112/manifest.json', oracleSha256: sha256(oraclePath) },
      node: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8', env: childEnvironment }).trim(),
        sourceHashes: Object.fromEntries(nodeSourceFiles.map(path => [path, sha256(resolve(repository, path))])) },
    },
  });
  report.harnessCompleted = true;
  } catch (error) {
    failure = error;
    report.harnessCompleted = false;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (connection) {
      if (created) {
        try {
          guardTarget();
          await connection.query(`DROP DATABASE \`${fixtureDatabase}\``);
          report.cleanup.dropped = true;
          report.cleanup.verifiedAbsent = (await rows(connection,
            'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [fixtureDatabase])).length === 0;
          if (!report.cleanup.verifiedAbsent) throw new Error('Fixture database still exists after cleanup');
        } catch (error) {
          failure ??= error;
          report.harnessCompleted = false;
          report.cleanup.error = error instanceof Error ? error.message : String(error);
        }
      }
      try { await connection.end(); }
      catch (error) {
        failure ??= error;
        report.harnessCompleted = false;
        report.cleanup.connectionError = error instanceof Error ? error.message : String(error);
      }
    }
    mkdirSync(runtime, { recursive: true });
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  const counts = report.counts;
  console.log(`Old-main differential: ${counts.compatible} compatible, ${counts.incompatible} incompatible, ${counts.positiveControls} modern controls passed.`);
  for (const result of results) console.log(`${result.finding.toUpperCase()} ${result.id}`);
  console.log(`Report: ${outputPath}`);
  console.log(`Cleanup: dropped=${report.cleanup.dropped}, verifiedAbsent=${report.cleanup.verifiedAbsent}`);
  process.exitCode = counts.incompatible ? 1 : 0;
}

main().catch(error => { console.error(`Old-main differential harness failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; });
