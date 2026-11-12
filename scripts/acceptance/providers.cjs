#!/usr/bin/env node
'use strict';

// Operator-run provider acceptance. This file is NOT a startup/CI/migration hook.
// --probe (default): config + fixed Yii/Node HTTP contracts + live STS HEAD use.
// --cos: EXPERIMENTAL ONLY; not approved for the running production bucket.
// Upload/read/remove two new bounded objects. Requires BOTH explicit write flags
// RUN_PROVIDER_COS_WRITE=1 and EXPERIMENTAL_UNSAFE_COS_WRITE=1. The latter is not
// an atomic-cleanup guarantee: COS DELETE If-Match support is not established.
// --cleanup: resume ownership-checked cleanup from the private signed ledger.
// --self-test: pure local fakes; no provider/network/filesystem mutation.
//
// RUN_PROVIDER_ACCEPTANCE=1 ACCEPTANCE_RUN_ID=codex_<unique-id>
// ACCEPTANCE_EXPECTED_NODE_COMMIT=d8294e95aa29d3aefa729107a1dd2f3b63d0d823
// node /tmp/providers.cjs --probe
//
// Run INSIDE the existing Node container (/app cwd); never export its secrets.
// The script prints status/shape/TTL/boolean outcomes, never response bodies,
// credentials, signed URLs, authorization headers, or exception messages.
// No login codes, orders, payments, refunds, SQL or Redis writes are performed.
// --probe does issue ephemeral STS credentials and reads an absent COS key.
// --cos uses STS for PUT/GET and the server's existing long-lived key for DELETE.
//
// COS safety sources, checked 2026-11-12:
// https://cloud.tencent.com/document/product/436/7749 (PUT, overwrite prevention)
// https://cloud.tencent.com/document/product/436/19888 (bucket versioning)
// https://cloud.tencent.com/document/product/436/7743 (exact object/version delete)
// https://cloud.tencent.com/document/product/436/7778 (COS V5 request signing)
// The source Qcloud COS SDK's Signature.php is the independent local signer
// oracle. PUT If-None-Match is ADDITIONAL, not the overwrite guarantee: COS's
// documented x-cos-forbid-overwrite only works when versioning was never enabled.
// Consequently this first version refuses COS writes for Enabled/Suspended or
// unknown bucket versioning, and never changes bucket policy/versioning. Even
// then, an unversioned object may be replaced between verification and DELETE;
// do not treat metadata/hash checks or If-Match as an atomic ownership check.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { isDeepStrictEqual } = require('node:util');

const APPROVED_COMMIT = 'd8294e95aa29d3aefa729107a1dd2f3b63d0d823';
const TARGETS = Object.freeze({ yii: 'https://x.b0.01xr.com', node: 'https://x2.b0.01xr.com' });
const MODES = new Set(['--probe', '--cos', '--cleanup', '--self-test']);
const MAX_BODY = 512 * 1024;
class ProviderAcceptanceError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new ProviderAcceptanceError(code); };
const codeOf = error => error instanceof ProviderAcceptanceError ? error.code : ['EEXIST', 'EACCES', 'ENOENT', 'ENOSPC', 'EROFS'].includes(error?.code) ? error.code : 'provider-operation-failed';
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha1', key).update(data).digest('hex');
const enc = text => encodeURIComponent(String(text)).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const runPattern = /^codex_[a-z0-9][a-z0-9_]{7,42}$/;
const ownKey = (runId, key) => runPattern.test(runId || '') && typeof key === 'string' && new RegExp('^codex-acceptance/' + runId + '/(?:yii|node)-[a-f0-9]{32}\\.txt$').test(key);

function configuration(env, args = []) {
  if (args.length > 1 || args[0] && !MODES.has(args[0])) fail('invalid-mode');
  const mode = args[0] || '--probe';
  if (mode === '--self-test') return { mode };
  if (env.RUN_PROVIDER_ACCEPTANCE !== '1') fail('provider-opt-in-required');
  if (!runPattern.test(env.ACCEPTANCE_RUN_ID || '')) fail('unique-run-id-required');
  if (env.ACCEPTANCE_EXPECTED_NODE_COMMIT !== APPROVED_COMMIT) fail('approved-node-commit-required');
  if (['--cos', '--cleanup'].includes(mode) && env.RUN_PROVIDER_COS_WRITE !== '1') fail('cos-write-opt-in-required');
  if (['--cos', '--cleanup'].includes(mode) && env.EXPERIMENTAL_UNSAFE_COS_WRITE !== '1') fail('unsafe-cos-write-mode-not-approved');
  const directory = env.ACCEPTANCE_PROVIDER_LEDGER_DIR || '/tmp/codex-provider-acceptance';
  if (!path.isAbsolute(directory)) fail('ledger-directory-must-be-absolute');
  return { mode, runId: env.ACCEPTANCE_RUN_ID, expectedNodeCommit: APPROVED_COMMIT, directory,
    ledgerPath: path.join(directory, env.ACCEPTANCE_RUN_ID + '.json') };
}
function loadApi() {
  const app = createRequire(path.resolve(process.cwd(), 'package.json'));
  const { Integrations } = app(path.resolve(process.cwd(), 'dist/integrations/integrations.js'));
  return new Integrations();
}
function storage(api) {
  const c = api.config;
  if (!/^[a-z0-9][a-z0-9-]{1,55}-[0-9]{5,20}$/.test(c.bucket || '') || !/^[a-z][a-z0-9-]{1,40}$/.test(c.region || '')) fail('configured-storage-required');
  if (!c.secretId || !c.secretKey) fail('server-cloud-credentials-required');
  return { host: c.bucket + '.cos.' + c.region + '.myqcloud.com', bucket: c.bucket, region: c.region,
    credentials: { id: c.secretId, key: c.secretKey } };
}
function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth >= 3 ? 'array' : ['array', value.length ? shape(value[0], depth + 1) : 'empty'];
  if (!record(value)) return typeof value;
  if (depth >= 3) return 'object';
  return Object.fromEntries(Object.keys(value).sort().slice(0, 40).map(key => [key, shape(value[key], depth + 1)]));
}
async function bounded(response, max = MAX_BODY) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) { await reader.cancel(); fail('response-limit-exceeded'); }
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function jsonRequest(url, fetcher = fetch) {
  let response;
  try { response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { Accept: 'application/json' } }); }
  catch { fail('backend-read-unavailable'); }
  let body;
  try { body = JSON.parse((await bounded(response)).toString('utf8')); }
  catch (error) { if (error instanceof ProviderAcceptanceError) throw error; fail('backend-json-invalid'); }
  return { status: response.status, body };
}
async function deploymentGate(config, fetcher = fetch) {
  const states = {};
  for (const [name, target] of Object.entries(TARGETS)) {
    const response = await jsonRequest(target + '/health', fetcher);
    states[name] = { status: response.status, healthy: response.body?.status === 'healthy',
      gitCommit: /^[a-f0-9]{40}$/.test(response.body?.gitCommit || '') ? response.body.gitCommit : null };
  }
  if (states.node.gitCommit !== config.expectedNodeCommit) fail('candidate-commit-mismatch');
  if (Object.values(states).some(state => state.status !== 200 || !state.healthy)) fail('deployment-health-gate-failed');
  return states;
}

// All requests are header-signed. Secret IDs/tokens never enter query strings.
// For these controlled ASCII object keys, this is byte-for-byte equivalent to
// the source PHP SDK signer when using the same signTime/Host/headers/query.
function cosAuthorization(method, url, headers, credentials, now = Math.floor(Date.now() / 1000)) {
  const time = (now - 60) + ';' + (now + 300);
  const byteOrder = (a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  const params = [...url.searchParams].map(([key, value]) => [enc(key).toLowerCase(), enc(value)]).sort(byteOrder);
  const signed = Object.entries(headers).map(([key, value]) => [enc(key).toLowerCase(), enc(value)]).sort(byteOrder);
  const canonical = method.toLowerCase() + '\n' + decodeURIComponent(url.pathname) + '\n' + params.map(pair => pair.join('=')).join('&') + '\n' + signed.map(pair => pair.join('=')).join('&') + '\n';
  const stringToSign = 'sha1\n' + time + '\n' + crypto.createHash('sha1').update(canonical).digest('hex') + '\n';
  return 'q-sign-algorithm=sha1&q-ak=' + credentials.id.trim() + '&q-sign-time=' + time + '&q-key-time=' + time + '&q-header-list=' + signed.map(pair => pair[0]).join(';') + '&q-url-param-list=' + params.map(pair => pair[0]).join(';') + '&q-signature=' + hmac(hmac(credentials.key.trim(), time), stringToSign);
}
function cosUrl(store, key, query = {}) {
  const url = new URL('https://' + store.host + '/' + key.split('/').map(enc).join('/'));
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}
async function cosRequest(store, method, key, credentials, options = {}, fetcher = fetch) {
  if (!['HEAD', 'GET', 'PUT', 'DELETE'].includes(method)) fail('cos-method-refused');
  const url = cosUrl(store, key, options.query);
  const headers = { host: store.host, ...options.headers, ...(credentials.token ? { 'x-cos-security-token': credentials.token } : {}) };
  headers.Authorization = cosAuthorization(method, url, headers, credentials);
  let response;
  try { response = await fetcher(url, { method, headers, ...(options.body ? { body: options.body } : {}), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { fail('cos-transport-unavailable'); }
  const body = method === 'HEAD' ? Buffer.alloc(0) : await bounded(response, options.limit || MAX_BODY);
  return { status: response.status, headers: response.headers, body };
}
function paymentConfiguration(api, env = process.env) {
  const c = api.config, result = { miniAppConfigured: !!c.appId && !!c.appSecret, merchantConfigured: !!c.mchId,
    apiV3KeyLengthValid: typeof c.apiV3Key === 'string' && Buffer.byteLength(c.apiV3Key) === 32,
    signingKeyReadable: false, signingRoundTrip: false, platformKeysReadable: false,
    merchantCertificatePresent: !!env.WECHAT_CERTIFICATE, merchantCertificateMatchesPrivate: null,
    merchantCertificateCurrent: null, merchantSerialMatchesCertificate: null, appInitialization: false };
  try {
    api.assertPaymentApplication(); result.appInitialization = true;
    const privateKey = crypto.createPrivateKey(c.privateKey), publicKey = crypto.createPublicKey(privateKey);
    result.signingKeyReadable = privateKey.asymmetricKeyType === 'rsa';
    const challenge = Buffer.from('codex-provider-config-check-v1');
    result.signingRoundTrip = crypto.verify('RSA-SHA256', challenge, publicKey, crypto.sign('RSA-SHA256', challenge, privateKey));
    const keys = Object.values(c.platformKeys || {});
    result.platformKeysReadable = keys.length > 0 && keys.every(key => crypto.createPublicKey(key).asymmetricKeyType === 'rsa');
    if (env.WECHAT_CERTIFICATE) {
      const reference = env.WECHAT_CERTIFICATE;
      const pem = reference.trimStart().startsWith('-----BEGIN ') ? reference.replace(/\\n/g, '\n') : fs.readFileSync(reference, 'utf8');
      const certificate = new crypto.X509Certificate(pem);
      result.merchantCertificateMatchesPrivate = certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }));
      const now = Date.now(); result.merchantCertificateCurrent = Date.parse(certificate.validFrom) <= now && now <= Date.parse(certificate.validTo);
      result.merchantSerialMatchesCertificate = String(c.serialNo || '').replace(/^0+/, '').toUpperCase() === certificate.serialNumber.replace(/^0+/, '').toUpperCase();
    }
  } catch { /* Booleans only; no filenames, PEMs, SDK errors or credentials. */ }
  result.available = result.miniAppConfigured && result.merchantConfigured && result.apiV3KeyLengthValid && result.signingKeyReadable && result.signingRoundTrip && result.platformKeysReadable && result.appInitialization
    && (!result.merchantCertificatePresent || result.merchantCertificateMatchesPrivate && result.merchantCertificateCurrent && result.merchantSerialMatchesCertificate);
  return result;
}
function temporary(body, storeRoute) {
  const data = storeRoute ? body?.data : body;
  const credentials = storeRoute ? { id: data?.tmpSecretId, key: data?.tmpSecretKey, token: data?.token } : { id: data?.Credentials?.TmpSecretId, key: data?.Credentials?.TmpSecretKey, token: data?.Credentials?.Token };
  const expiry = Number(storeRoute ? data?.expiredTime : data?.ExpiredTime);
  if (!Object.values(credentials).every(value => typeof value === 'string' && value.length > 1) || !Number.isFinite(expiry)) return null;
  return { credentials, ttlSeconds: Math.floor(expiry - Date.now() / 1000) };
}
async function providerProbes(config, api, request = cosRequest, fetcher = fetch) {
  const store = storage(api), results = [], usableCredentials = {};
  // Discovery is a separate stage: no backend may sign a credential for the
  // Node bucket until BOTH deployments' v1/v2 configuration agrees with it.
  // In particular, v1/token accepts a caller bucket; discovering a mismatch and
  // only marking the eventual result failed would already have changed scope.
  const discovery = {};
  const discoveryResults = [];
  for (const version of ['v1', 'v2']) {
    const id = 'cloud.' + version, pair = {}, bodies = {};
    discovery[id] = {};
    for (const [name, target] of Object.entries(TARGETS)) {
      try {
        const response = await jsonRequest(target + '/' + version + '/tencent-cloud/cloud', fetcher);
        discovery[id][name] = response; bodies[name] = response.body;
        pair[name] = { status: response.status, shape: shape(response.body), available: response.status === 200 && response.body?.bucket === store.bucket && response.body?.region === store.region };
      } catch (error) { pair[name] = { status: null, shape: null, available: false, error: codeOf(error) }; }
    }
    discoveryResults.push({ id, yii: pair.yii, node: pair.node, equal: pair.yii.available && pair.node.available && isDeepStrictEqual(bodies.yii, bodies.node) });
  }
  if (discoveryResults.some(row => !row.equal)) {
    const error = new ProviderAcceptanceError('storage-scope-discovery-mismatch');
    error.probeResults = discoveryResults; throw error;
  }
  const key = 'codex-acceptance/' + config.runId + '/probe-' + crypto.randomBytes(16).toString('hex') + '.txt';
  const descriptors = [
    ['wechat.application-config', '/v1/we-chat/info', 'info'],
    ['payment.app-id-config', '/v1/wechat-pay/info', 'app-id'],
    ['cloud.v1', '/v1/tencent-cloud/cloud', 'cloud'], ['cloud.v2', '/v2/tencent-cloud/cloud', 'cloud'],
    ['sts.v1.store', '/v1/tencent-cloud/store', 'store'],
    ['sts.v1.token', '/v1/tencent-cloud/token?bucket=' + enc(store.bucket) + '&region=' + enc(store.region), 'token'],
    ['sts.v2.store', '/v2/tencent-cloud/store', 'store'], ['sts.v2.token', '/v2/tencent-cloud/token', 'token'],
  ];
  for (const [id, route, kind] of descriptors) {
    const pair = {}, bodies = {};
    for (const [name, target] of Object.entries(TARGETS)) {
      try {
      const response = kind === 'cloud' ? discovery[id][name] : await jsonRequest(target + route, fetcher), body = response.body;
        bodies[name] = body;
        const item = { status: response.status, shape: shape(body), available: response.status === 200 };
        if (kind === 'info') item.available &&= record(body) && Object.keys(body).length === 0;
        if (kind === 'app-id') item.available &&= body === api.config.appId;
        if (kind === 'cloud') item.available &&= body?.bucket === store.bucket && body?.region === store.region;
        if (kind === 'store' || kind === 'token') {
          const issued = temporary(body, kind === 'store');
          item.temporaryCredentialsPresent = !!issued;
          item.ttlSeconds = issued?.ttlSeconds ?? null;
          item.available &&= !!issued && issued.ttlSeconds >= 30 && issued.ttlSeconds <= 7200;
          if (item.available) {
            const head = await request(store, 'HEAD', key, issued.credentials);
            item.cosHeadStatus = head.status; item.usableForMissingObjectHead = head.status === 404;
            item.available &&= item.usableForMissingObjectHead;
            if (kind === 'token' && id === 'sts.v2.token') usableCredentials[name] = issued.credentials;
          }
        }
        pair[name] = item;
      } catch (error) { pair[name] = { status: null, shape: null, available: false, error: codeOf(error) }; }
    }
    const left = { ...pair.yii }, right = { ...pair.node }; delete left.ttlSeconds; delete right.ttlSeconds;
    const ttlEqual = pair.yii.ttlSeconds === undefined || Number.isFinite(pair.yii.ttlSeconds) && Number.isFinite(pair.node.ttlSeconds) && Math.abs(pair.yii.ttlSeconds - pair.node.ttlSeconds) <= 5;
    const valuesEqual = ['info', 'app-id', 'cloud'].includes(kind) ? isDeepStrictEqual(bodies.yii, bodies.node) : true;
    results.push({ id, yii: pair.yii, node: pair.node, equal: pair.yii.available && pair.node.available && isDeepStrictEqual(left, right) && ttlEqual && valuesEqual });
    // Literal bodies and issued tokens remain scoped to this iteration.
  }
  return { store, results, usableCredentials };
}

function ledgerBinding(config, store) { return sha256(JSON.stringify({ host: store.host, commit: config.expectedNodeCommit, runId: config.runId })); }
function signingKey(store) { return crypto.createHmac('sha256', store.credentials.key).update('codex-provider-acceptance-ledger-v1').digest(); }
function persist(config, store, ledger, first = false) {
  const unsigned = { ...ledger }; delete unsigned.integrity;
  ledger.integrity = crypto.createHmac('sha256', signingKey(store)).update(JSON.stringify(unsigned)).digest('hex');
  if (first) {
    fs.mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(config.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || typeof process.getuid === 'function' && directory.uid !== process.getuid()) fail('private-ledger-directory-required');
    fs.writeFileSync(config.ledgerPath, JSON.stringify(ledger, null, 2), { flag: 'wx', mode: 0o600 });
  } else {
    const target = config.ledgerPath + '.' + crypto.randomBytes(12).toString('hex') + '.next';
    fs.writeFileSync(target, JSON.stringify(ledger, null, 2), { flag: 'wx', mode: 0o600 }); fs.renameSync(target, config.ledgerPath);
  }
}
function readLedger(config, store) {
  const fd = fs.openSync(config.ledgerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let ledger;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 65536 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('private-ledger-file-required');
    ledger = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  const unsigned = { ...ledger }; delete unsigned.integrity;
  const expected = crypto.createHmac('sha256', signingKey(store)).update(JSON.stringify(unsigned)).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(ledger.integrity || '') || !crypto.timingSafeEqual(Buffer.from(ledger.integrity), Buffer.from(expected))
    || ledger.runId !== config.runId || ledger.binding !== ledgerBinding(config, store) || !Array.isArray(ledger.objects) || ledger.objects.length !== 2) fail('ledger-integrity-or-binding-invalid');
  for (const object of ledger.objects) if (!ownKey(config.runId, object.key) || !/^[a-f0-9]{32}$/.test(object.owner || '') || !/^[a-f0-9]{64}$/.test(object.sha256 || '') || !/^[a-f0-9]{32}$/.test(object.md5 || '') || !Number.isInteger(object.bytes) || object.bytes < 1 || object.bytes > 1024) fail('ledger-object-proof-invalid');
  return ledger;
}
function versioning(body) {
  const xml = body.toString('utf8').trim();
  const root = /^(?:<\?xml[^?]*\?>\s*)?<VersioningConfiguration(\s+[^<>]*?)?\s*(?:\/>|>([\s\S]*)<\/VersioningConfiguration>)\s*$/.exec(xml);
  if (!root) fail('cos-versioning-response-invalid');
  const attributes = (root[1] || '').trim(), content = (root[2] || '').trim();
  if (attributes && !/^(?:xmlns(?::[A-Za-z_][A-Za-z0-9_.-]*)?\s*=\s*(?:"[^"<>]*"|'[^'<>]*')\s*)+$/.test(attributes)) fail('cos-versioning-state-unknown');
  // Only an explicitly empty configuration means "never enabled". Unknown
  // children, status attributes/namespaces, comments or truncated XML fail shut.
  if (!content) return 'never-enabled';
  const status = /^<Status>\s*(Enabled|Suspended)\s*<\/Status>$/.exec(content);
  if (status) return status[1];
  fail('cos-versioning-state-unknown');
}
async function requireUnversioned(store, request) {
  const response = await request(store, 'GET', '', store.credentials, { query: { versioning: '' } });
  if (response.status !== 200) fail('cos-versioning-read-required-before-write');
  if (versioning(response.body) !== 'never-enabled') fail('cos-versioned-overwrite-protection-not-supported');
}
async function cleanupObject(config, store, object, request, save) {
  if (!ownKey(config.runId, object.key)) fail('cos-cleanup-key-refused');
  if (!object.putAttempted || object.putRejected || object.collision) return { key: object.key, restored: true, changed: false };
  const query = object.versionId ? { versionId: object.versionId } : {};
  const head = await request(store, 'HEAD', object.key, store.credentials, { query });
  if (head.status === 404) {
    // A timed-out PUT can finish after the first HEAD. Keep an uncertain write
    // in the ledger for a later --cleanup instead of claiming it was restored.
    const restored = object.putSucceeded || object.deleteSucceeded;
    object.cleanup = restored ? 'missing-verified' : 'write-outcome-uncertain'; save();
    return { key: object.key, restored, changed: !!object.putSucceeded, ...restored ? {} : { error: 'write-outcome-uncertain-recheck-required' } };
  }
  if (head.status !== 200) fail('cos-cleanup-head-unavailable');
  if (head.headers.get('x-cos-meta-codex-run') !== config.runId || head.headers.get('x-cos-meta-codex-owner') !== object.owner
    || head.headers.get('x-cos-meta-codex-sha256') !== object.sha256 || Number(head.headers.get('content-length')) !== object.bytes
    || !head.headers.get('etag') || object.etag && head.headers.get('etag') !== object.etag) fail('cos-cleanup-ownership-changed');
  const observedVersion = head.headers.get('x-cos-version-id');
  if (!object.versionId && observedVersion && observedVersion !== 'null') { object.versionId = observedVersion; save(); }
  if (object.versionId && observedVersion !== object.versionId) fail('cos-cleanup-version-changed');
  const exact = object.versionId ? { versionId: object.versionId } : {};
  const body = await request(store, 'GET', object.key, store.credentials, { query: exact, limit: 1024 });
  if (body.status !== 200 || sha256(body.body) !== object.sha256) fail('cos-cleanup-content-changed');
  // Never send a versionless DELETE into a bucket whose versioning changed.
  if (!object.versionId) await requireUnversioned(store, request);
  // Defense in depth only: COS documentation does not promise conditional
  // DELETE via If-Match. A versionless DELETE still has a concurrency window;
  // this experimental write mode must not be used as an atomic CAS guarantee.
  const removed = await request(store, 'DELETE', object.key, store.credentials, { query: exact, headers: { 'if-match': head.headers.get('etag') } });
  if (![200, 204].includes(removed.status) || removed.headers.get('x-cos-delete-marker') === 'true') fail('cos-delete-not-confirmed');
  object.deleteSucceeded = true; save();
  const absent = await request(store, 'HEAD', object.key, store.credentials, { query: exact });
  object.cleanup = absent.status === 404 ? 'missing-verified' : 'delete-not-verified'; save();
  return { key: object.key, restored: absent.status === 404, changed: true };
}
async function cleanupAll(config, store, ledger, request, save) {
  const outcomes = [];
  for (const object of ledger.objects) {
    try { outcomes.push(await cleanupObject(config, store, object, request, save)); }
    catch (error) { outcomes.push({ key: object.key, restored: false, error: codeOf(error), ...(object.versionId ? { versionId: object.versionId } : {}) }); }
  }
  ledger.cleanup = outcomes; ledger.restored = outcomes.every(row => row.restored); save();
  return { restored: ledger.restored, objects: outcomes };
}
async function objectRoundTrips(config, store, credentials, ledger, request, save, cleanupRequest = request) {
  const results = ledger.results = [];
  try {
    await requireUnversioned(store, request);
    for (const object of ledger.objects) {
      if (!credentials[object.source]) fail('usable-sts-required-for-cos-write');
      if (!ownKey(config.runId, object.key)) fail('cos-object-prefix-refused');
      const absent = await request(store, 'HEAD', object.key, store.credentials);
      if (absent.status !== 404) fail(absent.status === 200 ? 'cos-object-collision' : 'cos-absence-not-confirmed');
      const body = Buffer.from(object.payload, 'utf8');
      object.putAttempted = true; save();
      let put;
      try {
        put = await request(store, 'PUT', object.key, credentials[object.source], { body, headers: {
          'if-none-match': '*', 'x-cos-forbid-overwrite': 'true', 'content-type': 'text/plain; charset=utf-8',
          'content-length': String(body.length), 'content-md5': crypto.createHash('md5').update(body).digest('base64'),
          'x-cos-meta-codex-run': config.runId, 'x-cos-meta-codex-owner': object.owner, 'x-cos-meta-codex-sha256': object.sha256,
        } });
      } catch (error) { object.putUncertain = true; save(); throw error; }
      if (put.status !== 200) {
        object.collision = [409, 412].includes(put.status); object.putRejected = put.status >= 400 && put.status < 500; save();
        fail(object.collision ? 'cos-create-only-write-refused' : 'cos-put-failed');
      }
      object.putSucceeded = true;
      if (put.headers.get('etag')) object.etag = put.headers.get('etag');
      const returnedVersion = put.headers.get('x-cos-version-id');
      if (returnedVersion && returnedVersion !== 'null') object.versionId = returnedVersion;
      save();
      const read = await request(store, 'GET', object.key, credentials[object.source], { query: object.versionId ? { versionId: object.versionId } : {}, limit: 1024 });
      const equal = read.status === 200 && sha256(read.body) === object.sha256;
      results.push({ id: 'cos.' + object.source + '.new-object-roundtrip', key: object.key, putStatus: put.status, getStatus: read.status, bytes: object.bytes, hashVerified: equal, versioned: !!object.versionId, equal });
      save();
      if (!equal) fail('cos-roundtrip-hash-mismatch');
    }
    return results;
  } finally { ledger.cleanup = (await cleanupAll(config, store, ledger, cleanupRequest, save)).objects; }
}
function newLedger(config, store) {
  return { version: 1, runId: config.runId, binding: ledgerBinding(config, store), createdAt: new Date().toISOString(), expectedNodeCommit: config.expectedNodeCommit,
    objects: ['yii', 'node'].map(source => {
      const owner = crypto.randomBytes(16).toString('hex'), nonce = crypto.randomBytes(16).toString('hex');
      const payload = 'codex-provider-acceptance-v1\n' + config.runId + '\n' + source + '\n' + owner + '\n';
      return { source, key: 'codex-acceptance/' + config.runId + '/' + source + '-' + nonce + '.txt', owner, payload,
        bytes: Buffer.byteLength(payload), sha256: sha256(payload), md5: crypto.createHash('md5').update(payload).digest('hex'), putAttempted: false };
    }) };
}

async function selfTest() {
  const env = { RUN_PROVIDER_ACCEPTANCE: '1', ACCEPTANCE_RUN_ID: 'codex_test_provider_1234', ACCEPTANCE_EXPECTED_NODE_COMMIT: APPROVED_COMMIT, RUN_PROVIDER_COS_WRITE: '1', EXPERIMENTAL_UNSAFE_COS_WRITE: '1' };
  assert.throws(() => configuration({}, []), /provider-opt-in-required/);
  assert.throws(() => configuration({ ...env, ACCEPTANCE_EXPECTED_NODE_COMMIT: '6'.repeat(40) }, []), /approved-node-commit-required/);
  assert.throws(() => configuration({ ...env, RUN_PROVIDER_COS_WRITE: '0' }, ['--cos']), /cos-write-opt-in-required/);
  assert.throws(() => configuration({ ...env, EXPERIMENTAL_UNSAFE_COS_WRITE: '0' }, ['--cos']), /unsafe-cos-write-mode-not-approved/);
  assert.throws(() => configuration({ ...env, EXPERIMENTAL_UNSAFE_COS_WRITE: '0' }, ['--cleanup']), /unsafe-cos-write-mode-not-approved/);
  assert.equal(configuration({ ...env, EXPERIMENTAL_UNSAFE_COS_WRITE: '0' }, ['--probe']).mode, '--probe');
  assert.throws(() => configuration({ ...env, ACCEPTANCE_RUN_ID: '../x' }, []), /unique-run-id-required/);
  const config = configuration(env, ['--cos']);
  const store = { host: 'fixture-1250000000.cos.ap-nanjing.myqcloud.com', credentials: { id: 'synthetic-id', key: 'synthetic-key' } };
  const token = { yii: { id: 'synthetic-yii', key: 'synthetic-yii-key', token: 'synthetic-yii-token' }, node: { id: 'synthetic-node', key: 'synthetic-node-key', token: 'synthetic-node-token' } };
  assert.equal(ownKey(config.runId, 'unrelated/object.txt'), false);
  assert.equal(versioning(Buffer.from('<VersioningConfiguration/>')), 'never-enabled');
  assert.equal(versioning(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://cos.example/"/>')), 'never-enabled');
  assert.equal(versioning(Buffer.from('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>')), 'Enabled');
  assert.equal(versioning(Buffer.from('<VersioningConfiguration xmlns="http://cos.example/"><Status>Suspended</Status></VersioningConfiguration>')), 'Suspended');
  assert.throws(() => versioning(Buffer.from('<Error/>')), /cos-versioning-response-invalid/);
  for (const xml of ['<VersioningConfiguration><Status xmlns="urn:example">Enabled</Status></VersioningConfiguration>', '<VersioningConfiguration><Unexpected>Enabled</Unexpected></VersioningConfiguration>', '<VersioningConfiguration><Status/></VersioningConfiguration>', '<VersioningConfiguration><Status>FutureState</Status></VersioningConfiguration>', '<VersioningConfiguration enabled="true"/>']) assert.throws(() => versioning(Buffer.from(xml)), /cos-versioning-state-unknown/);
  const probeApi = { config: { bucket: 'fixture-1250000000', region: 'ap-nanjing', secretId: 'synthetic-id', secretKey: 'synthetic-key', appId: 'synthetic-app' } };
  const discoveryCalls = [];
  const mismatch = async input => {
    const url = new URL(input); discoveryCalls.push(url.pathname);
    return Response.json({ bucket: url.hostname === 'x.b0.01xr.com' ? 'other-1250000000' : probeApi.config.bucket, region: probeApi.config.region });
  };
  await assert.rejects(providerProbes(config, probeApi, async () => fail('probe-cos-call-before-scope-gate'), mismatch), /storage-scope-discovery-mismatch/);
  assert.equal(discoveryCalls.length, 4); assert.equal(discoveryCalls.filter(url => /\/(?:store|token)$/.test(url)).length, 0);
  const probeMethods = [], backendCalls = [];
  const matching = async input => {
    const url = new URL(input); backendCalls.push(url.pathname);
    if (url.pathname.endsWith('/cloud')) return Response.json({ bucket: probeApi.config.bucket, region: probeApi.config.region });
    if (url.pathname.endsWith('/we-chat/info')) return Response.json({});
    if (url.pathname.endsWith('/wechat-pay/info')) return Response.json(probeApi.config.appId);
    const credentials = { TmpSecretId: 'synthetic-id', TmpSecretKey: 'synthetic-key', Token: 'synthetic-token' }, expiry = Math.floor(Date.now() / 1000) + 1800;
    return Response.json(url.pathname.endsWith('/store') ? { data: { tmpSecretId: credentials.TmpSecretId, tmpSecretKey: credentials.TmpSecretKey, token: credentials.Token, expiredTime: expiry } } : { Credentials: credentials, ExpiredTime: expiry });
  };
  const probed = await providerProbes(config, probeApi, async (_store, method) => { probeMethods.push(method); return { status: 404 }; }, matching);
  assert.equal(probed.results.length, 8); assert(probed.results.every(row => row.equal));
  assert.equal(backendCalls.filter(url => /\/(?:store|token)$/.test(url)).length, 8); assert.deepEqual([...new Set(probeMethods)], ['HEAD']);
  const url = cosUrl(store, 'fixture.txt', { versionId: 'v+1/=' });
  const authorization = cosAuthorization('DELETE', url, { host: store.host, 'if-match': '"abcd"' }, store.credentials, 1700000000);
  assert.match(authorization, /q-header-list=host;if-match&q-url-param-list=versionid/);
  assert.equal(authorization.includes(store.credentials.key), false);
  const state = new Map(), calls = [], saves = [];
  const request = async (_store, method, key, _credentials, options = {}) => {
    calls.push({ method, key, options });
    if (!key && options.query?.versioning !== undefined) return { status: 200, headers: new Headers(), body: Buffer.from('<VersioningConfiguration/>') };
    const found = state.get(key);
    if (method === 'HEAD') return { status: found ? 200 : 404, headers: new Headers(found?.headers || {}), body: Buffer.alloc(0) };
    if (method === 'PUT') {
      assert.equal(options.headers['if-none-match'], '*'); assert.equal(options.headers['x-cos-forbid-overwrite'], 'true');
      assert.match(key, /^codex-acceptance\//); assert.equal(found, undefined);
      state.set(key, { body: options.body, headers: { ...options.headers, etag: '"' + crypto.createHash('md5').update(options.body).digest('hex') + '"' } });
      return { status: 200, headers: new Headers(), body: Buffer.alloc(0) };
    }
    if (method === 'GET') return { status: found ? 200 : 404, headers: new Headers(), body: found?.body || Buffer.alloc(0) };
    if (method === 'DELETE') { assert.ok(found); state.delete(key); return { status: 204, headers: new Headers(), body: Buffer.alloc(0) }; }
    throw Error('unexpected test request');
  };
  const ledger = newLedger(config, store), save = () => saves.push(JSON.stringify(ledger));
  const results = await objectRoundTrips(config, store, token, ledger, request, save);
  assert.equal(results.length, 2); assert.ok(results.every(row => row.equal)); assert.ok(ledger.restored); assert.equal(state.size, 0);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 2); assert.equal(calls.filter(call => call.method === 'DELETE').length, 2);
  const collision = newLedger(config, store), foreignKey = collision.objects[0].key;
  state.set(foreignKey, { body: Buffer.from('preexisting'), headers: { 'content-length': '11' } });
  const beforeCollisionWrites = calls.filter(call => ['PUT', 'DELETE'].includes(call.method)).length;
  await assert.rejects(objectRoundTrips(config, store, token, collision, request, () => {}), /cos-object-collision/);
  assert.equal(calls.filter(call => ['PUT', 'DELETE'].includes(call.method)).length, beforeCollisionWrites);
  assert.ok(state.has(foreignKey)); state.delete(foreignKey);
  const failedRead = newLedger(config, store); let corruptOnce = true;
  const corrupt = async (...args) => {
    const response = await request(...args);
    if (args[1] === 'GET' && args[2] && corruptOnce) { corruptOnce = false; return { ...response, body: Buffer.from('bad') }; }
    return response;
  };
  await assert.rejects(objectRoundTrips(config, store, token, failedRead, corrupt, () => {}), /cos-roundtrip-hash-mismatch/);
  assert.ok(failedRead.restored); assert.equal(state.size, 0);
  const lostAck = newLedger(config, store); let loseOnce = true;
  const lose = async (...args) => {
    const response = await request(...args);
    if (args[1] === 'PUT' && loseOnce) { loseOnce = false; fail('synthetic-put-ack-lost'); }
    return response;
  };
  await assert.rejects(objectRoundTrips(config, store, token, lostAck, lose, () => {}), /synthetic-put-ack-lost/);
  assert.ok(lostAck.restored); assert.equal(state.size, 0);
  const guarded = newLedger(config, store), object = guarded.objects[0]; object.putAttempted = object.putSucceeded = true;
  const noDelete = async (_store, method) => { assert.notEqual(method, 'DELETE'); return { status: 200, headers: new Headers({ 'x-cos-meta-codex-owner': 'foreign' }), body: Buffer.alloc(0) }; };
  assert.equal((await cleanupAll(config, store, guarded, noDelete, () => {})).restored, false);
  const uncertain = newLedger(config, store); uncertain.objects[0].putAttempted = true;
  const missing = async () => ({ status: 404, headers: new Headers(), body: Buffer.alloc(0) });
  assert.equal((await cleanupAll(config, store, uncertain, missing, () => {})).restored, false);
  const rejected = newLedger(config, store);
  const enabled = async (_store, method) => { assert.equal(method, 'GET'); return { status: 200, headers: new Headers(), body: Buffer.from('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>') }; };
  await assert.rejects(objectRoundTrips(config, store, token, rejected, enabled, () => {}), /cos-versioned-overwrite-protection-not-supported/);
  assert.ok(rejected.restored);
  const summary = { configuration: true, experimentalWritesBlockedByDefault: true, scopeMismatchBeforeAnySts: true, matchedScopeProbeOnlyHeads: true, unknownVersioningRefusal: true, signingSafety: true, twoTemporaryCredentialRoundtrips: true, ownedFixtureCleanup: true, existingObjectUntouched: true,
    failedReadCleanup: true, lostPutAcknowledgmentCleanup: true, ownershipRefusal: true, uncertainWriteRefusal: true, versionedBucketRefusal: true };
  assert.equal(JSON.stringify(summary).includes(token.yii.key), false);
  return { selfTest: true, networkRequests: 0, filesystemWrites: 0, checks: summary,
    limitations: ['Unversioned DELETE is not established to honor If-Match atomically.', 'Experimental COS writes are not approved for the production bucket.'] };
}
async function main(env = process.env, args = process.argv.slice(2)) {
  const config = configuration(env, args);
  if (config.mode === '--self-test') return selfTest();
  const api = loadApi(), store = storage(api);
  if (config.mode === '--cleanup') {
    const ledger = readLedger(config, store), save = () => persist(config, store, ledger);
    const outcome = await cleanupAll(config, store, ledger, cosRequest, save);
    if (!outcome.restored) process.exitCode = 1;
    return { runId: config.runId, mode: config.mode, cleanup: outcome, atomicCleanupGuarantee: false,
      note: 'Cleanup is bound to the signed original run; versionless DELETE still has a concurrency window. This experimental mode is not approved for production.' };
  }
  const summary = { runId: config.runId, mode: config.mode, startedAt: new Date().toISOString(), deployments: await deploymentGate(config),
    paymentConfiguration: paymentConfiguration(api, env), results: [], cosWritesStarted: false,
    limitations: ['Real WeChat login/phone codes require user participation.', 'No real order, payment, refund or callback was executed.', 'Configuration/signing checks do not prove merchant payment acceptance.',
      'COS object writes are experimental and not approved for the production bucket; versionless DELETE is not an atomic ownership check.'] };
  let ledger;
  let interrupted = false;
  const stop = () => { interrupted = true; };
  const workRequest = async (...args) => { if (interrupted) fail('interrupted'); return cosRequest(...args); };
  const workFetch = async (...args) => { if (interrupted) fail('interrupted'); return fetch(...args); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const probes = await providerProbes(config, api, workRequest, workFetch); summary.results = probes.results;
    if (config.mode === '--cos') {
      if (summary.results.filter(row => /^cloud\.|^sts\./.test(row.id)).some(row => !row.equal)) fail('cloud-probes-must-pass-before-cos-write');
      ledger = newLedger(config, store); persist(config, store, ledger, true);
      const save = () => persist(config, store, ledger);
      await objectRoundTrips(config, store, probes.usableCredentials, ledger, workRequest, save, cosRequest);
      summary.cleanup = { restored: ledger.restored, objects: ledger.cleanup };
    }
    if (interrupted) fail('interrupted');
    summary.completed = true;
  } catch (error) {
    if (error instanceof ProviderAcceptanceError && Array.isArray(error.probeResults)) summary.results = error.probeResults;
    summary.error = interrupted ? 'interrupted' : codeOf(error); summary.completed = false;
  }
  finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (ledger) { summary.cosWritesStarted = ledger.objects.some(object => object.putAttempted); summary.results.push(...ledger.results || []); }
    if (ledger) summary.cleanup = { restored: ledger.restored === true, objects: ledger.cleanup || [],
      ...ledger.restored ? {} : { pendingObjects: ledger.objects.filter(object => object.putAttempted && !object.putRejected && object.cleanup !== 'missing-verified').map(object => ({ key: object.key, ...(object.versionId ? { versionId: object.versionId } : {}) })) } };
    summary.passed = summary.results.filter(row => row.equal).length; summary.total = summary.results.length;
    summary.paymentConfigurationAvailable = summary.paymentConfiguration.available;
    summary.finishedAt = new Date().toISOString();
    if (!summary.completed || !summary.paymentConfigurationAvailable || summary.results.some(row => !row.equal) || ledger && !ledger.restored) process.exitCode = 1;
  }
  return summary;
}

module.exports = { configuration, cosAuthorization, cosUrl, versioning, shape, paymentConfiguration, deploymentGate, providerProbes, newLedger, cleanupAll, objectRoundTrips, main };
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => { console.log(JSON.stringify({ completed: false, error: codeOf(error), cosWritesStarted: false })); process.exitCode = 1; });
