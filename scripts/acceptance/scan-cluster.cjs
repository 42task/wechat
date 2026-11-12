#!/usr/bin/env node
'use strict';

// Operator-reviewed, recoverable ONE-ROW scan fixture, run INSIDE the b0 Node
// container from its application root. The live mode must never run automatically
// or from CI; CI may run only the synthetic --self-test mode below.
//
// RUN_SCAN_CLUSTER_ACCEPTANCE=1 ACCEPTANCE_RUN_ID=codex_scan_<unique-id>
// ACCEPTANCE_EXPECTED_NODE_COMMIT=4bcd38b83f42bf6333d1758e48f1b9c8007ad55c
// node /path/to/scan-cluster.cjs
//
// The same flags/run ID plus --cleanup resume exact-marker cleanup from a
// mode-0600 local ledger after interruption. --self-test uses synthetic adapters
// only and does not connect to SQL, Redis, HTTP, or any provider.
//
// Deliberately DO NOT call ticket creation: the real create route also deletes
// old tickets and expires unrelated pending tickets globally. A direct owned
// INSERT avoids those side effects. Thus QR generation, creation throttling,
// WeChat approval, login, consumption, sessions, and real accounts are NOT tested.
// The private /tmp ledger survives process interruption, not container removal.
// A changed SQL/Redis identity intentionally blocks automatic recovery; keep the
// container stable until cleanup succeeds. Fixed aliases do not by themselves
// prove distinct Node processes; their configured targets need separate evidence.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const EXPECTED_COMMIT = '4bcd38b83f42bf6333d1758e48f1b9c8007ad55c';
const ORIGIN = 'https://c.4mr.cn';
const FRONT = Object.freeze({
  b0: ORIGIN + '/api/backends/b0',
  b1: ORIGIN + '/api/backends/b1',
});
const LEDGER_DIRECTORY = '/tmp/codex-scan-cluster';
const FORBIDDEN_ENDPOINTS = /\/(?:create|consume|approve|login|logout|refresh|session)(?:\/|$)/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
class FixtureError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new FixtureError(code); };
const codeOf = error => error instanceof FixtureError ? error.code : 'fixture-operation-failed';
const hex = (value, length) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value);

function configuration(env, args) {
  if (args.length > 1 || args[0] && !['--cleanup', '--self-test'].includes(args[0])) fail('invalid-mode');
  if (args[0] === '--self-test') return { mode: '--self-test' };
  if (env.RUN_SCAN_CLUSTER_ACCEPTANCE !== '1') fail('explicit-fixture-write-opt-in-required');
  if (env.ACCEPTANCE_EXPECTED_NODE_COMMIT !== EXPECTED_COMMIT || env.GIT_COMMIT !== EXPECTED_COMMIT) fail('approved-container-commit-required');
  if (!/^codex_scan_[a-z0-9][a-z0-9_]{7,42}$/.test(env.ACCEPTANCE_RUN_ID || '')) fail('unique-run-id-required');
  return { mode: args[0] || 'run', runId: env.ACCEPTANCE_RUN_ID,
    ledgerPath: path.join(LEDGER_DIRECTORY, env.ACCEPTANCE_RUN_ID + '.json') };
}

function dependencies() {
  const app = createRequire(path.resolve(process.cwd(), 'package.json'));
  return {
    Database: app(path.resolve(process.cwd(), 'dist/core/database.js')).Database,
    ...app(path.resolve(process.cwd(), 'dist/core/redis.js')),
    canonicalOrigin: app(path.resolve(process.cwd(), 'dist/admin/tickets.js')).canonicalOrigin,
    adminIssuer: app(path.resolve(process.cwd(), 'dist/admin/token-store.js')).adminIssuer,
  };
}

function privateFile(file) {
  const entry = fs.lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && entry.uid !== process.getuid()) fail('ledger-must-be-private');
}
function privateDirectory() {
  try { fs.mkdirSync(LEDGER_DIRECTORY, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const directory = fs.lstatSync(LEDGER_DIRECTORY);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0
    || typeof process.getuid === 'function' && directory.uid !== process.getuid()) fail('ledger-directory-must-be-private');
}
function persist(config, ledger, first = false) {
  privateDirectory();
  const serialized = JSON.stringify(ledger) + '\n';
  const write = file => {
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, serialized); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  };
  if (first) write(config.ledgerPath);
  else {
    privateFile(config.ledgerPath);
    const temporary = config.ledgerPath + '.' + crypto.randomBytes(8).toString('hex') + '.next';
    write(temporary);
    fs.renameSync(temporary, config.ledgerPath);
  }
  privateFile(config.ledgerPath);
}
function loadLedger(config) {
  privateDirectory();
  privateFile(config.ledgerPath);
  const ledger = JSON.parse(fs.readFileSync(config.ledgerPath, 'utf8'));
  validateLedger(config, ledger);
  return ledger;
}
function validateLedger(config, ledger) {
  if (ledger.version !== 1 || ledger.runId !== config.runId || ledger.commit !== EXPECTED_COMMIT
    || ledger.audience !== ORIGIN || !hex(ledger.id, 32) || !hex(ledger.ownerProof, 64)
    || ledger.ownerHash !== hash(ledger.ownerProof) || !hex(ledger.secretHash, 64) || !hex(ledger.binding, 64)
    || !Number.isInteger(ledger.createdAt) || ledger.expiresAt !== ledger.createdAt + 300
    || ledger.ticketPreAbsent !== true || ledger.ownerLockPreAbsent !== true) fail('invalid-fixture-ledger');
}
function ownLock(ledger) { return 'game:admin:auth:owner-lock:' + ledger.ownerHash; }
function ownsRow(row, ledger) {
  return !!row && row.id === ledger.id && row.owner_hash === ledger.ownerHash
    && row.secret_hash === ledger.secretHash && row.audience === ledger.audience
    && Number(row.created_at) === ledger.createdAt && Number(row.expires_at) === ledger.expiresAt
    && row.approved_user_id == null && row.approved_at == null && row.consumed_at == null
    && ['pending', 'cancelled', 'expired'].includes(row.status);
}
async function readOwned(db, ledger) {
  const row = await db.one('SELECT * FROM admin_scan_login_ticket WHERE id=?', [ledger.id]);
  if (row && !ownsRow(row, ledger)) fail('fixture-ownership-changed');
  return row;
}

function requestJson(urlString, method = 'GET', ownerProof = null) {
  const url = new URL(urlString);
  const localHealth = urlString === 'http://127.0.0.1:8080/health';
  const frontHealth = Object.values(FRONT).some(base => urlString === base + '/health');
  const ticketPath = /^\/api\/backends\/b[01]\/admin-api\/scan-login\/tickets\/[a-f0-9]{32}(?:\/cancel)?$/.test(url.pathname);
  if (!localHealth && !(url.origin === ORIGIN && (frontHealth || ticketPath))) fail('http-target-not-allowlisted');
  if (FORBIDDEN_ENDPOINTS.test(url.pathname) && !ticketPath) fail('forbidden-auth-endpoint');
  if ((localHealth || frontHealth) && (method !== 'GET' || ownerProof !== null)) fail('health-must-be-read-only');
  if (ticketPath && (!hex(ownerProof, 64) || !['GET', 'POST'].includes(method)
    || method === 'POST' && !url.pathname.endsWith('/cancel')
    || method === 'GET' && url.pathname.endsWith('/cancel'))) fail('invalid-ticket-request');
  if (url.search || url.hash || url.username || url.password) fail('unexpected-http-url-components');
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json', ...(ownerProof ? { 'X-Admin-Scan-Owner': ownerProof } : {}),
      ...(localHealth ? { Host: '0.0.0.0' } : {}) };
    const transport = localHealth ? http : https;
    // Native HTTPS verifies certificates and does not use ambient proxy ENV.
    // No cookies, Bearer, WeChat code, body, redirect or automatic retry is sent.
    const req = transport.request(url, { method, headers, agent: false, rejectUnauthorized: true }, res => {
      const buffers = [];
      let size = 0;
      res.on('error', () => reject(new FixtureError('http-response-interrupted')));
      res.on('aborted', () => reject(new FixtureError('http-response-interrupted')));
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 16384) req.destroy(new FixtureError('unexpected-http-body-size'));
        else buffers.push(chunk);
      });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(buffers).toString('utf8')) }); }
        catch { reject(new FixtureError('unexpected-http-response')); }
      });
    });
    const timeout = setTimeout(() => req.destroy(new FixtureError('http-deadline-exceeded')), 10000);
    req.on('close', () => clearTimeout(timeout));
    req.on('error', () => reject(new FixtureError('http-request-failed')));
    req.end();
  });
}

async function deploymentGate(checks) {
  for (const [name, url] of [['localNodeHealth', 'http://127.0.0.1:8080/health'],
    ['frontB0Health', FRONT.b0 + '/health'], ['frontB1Health', FRONT.b1 + '/health']]) {
    const response = await requestJson(url);
    checks[name] = response.status === 200 && response.body?.status === 'healthy'
      && response.body.gitCommit === EXPECTED_COMMIT && response.body.checks?.database?.status === 'up'
      && response.body.checks?.redis?.status === 'up';
    if (!checks[name]) fail('deployment-health-or-commit-mismatch');
  }
}
async function schemaGate(db) {
  const database = await db.one('SELECT DATABASE() AS databaseName');
  if (!database?.databaseName) fail('metadata-visibility-not-confirmed');
  const quoted = '`' + String(database.databaseName).replaceAll('`', '``') + '`';
  const grants = await db.query('SHOW GRANTS FOR CURRENT_USER()');
  let selectVisible = false, triggerVisible = false;
  for (const grant of grants.flatMap(row => Object.values(row)).filter(value => typeof value === 'string')) {
    const parsed = /^GRANT (.+?) ON (.+?) TO /i.exec(grant);
    if (!parsed) continue;
    const privileges = parsed[1].toUpperCase().split(/\s*,\s*/);
    const all = privileges.includes('ALL PRIVILEGES');
    const schemaScope = parsed[2] === '*.*' || parsed[2] === quoted + '.*';
    const ticketScope = schemaScope || parsed[2] === quoted + '.`admin_scan_login_ticket`';
    if (schemaScope && (all || privileges.includes('SELECT'))) selectVisible = true;
    if (ticketScope && (all || privileges.includes('TRIGGER'))) triggerVisible = true;
  }
  // An empty information_schema.TRIGGERS result without TRIGGER visibility
  // cannot establish absence. Conservatively reject role-only/hidden grants.
  if (!selectVisible || !triggerVisible) fail('metadata-visibility-not-confirmed');
  const triggers = await db.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', ['admin_scan_login_ticket']);
  const references = await db.query('SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME=?', ['admin_scan_login_ticket']);
  if (triggers.length || references.length) fail('ticket-table-has-nonfixture-side-effects');
}
async function targetBinding(db, redis, redisOptions) {
  // With no URL, LegacyRedis passes this resolved database directly to
  // createClient({ database: config.database ?? 0 }). Managed Redis may forbid
  // CLIENT INFO. Refuse URL configuration rather than guess its DB precedence.
  if (!redisOptions || redisOptions.url !== undefined) fail('redis-url-binding-not-supported');
  const redisDb = redisOptions.database ?? 0;
  if (!Number.isInteger(redisDb) || redisDb < 0 || redisDb > 2147483647) fail('redis-database-binding-invalid');
  const sql = await db.one('SELECT @@server_uuid AS serverUuid,DATABASE() AS databaseName');
  const server = String(await redis.command(['INFO', 'server']));
  const redisRunId = /^run_id:([^\r\n]+)$/m.exec(server)?.[1];
  if (!sql?.serverUuid || !sql.databaseName || !redisRunId) fail('target-binding-unavailable');
  // This recovery fingerprint stays only in the private ledger, never stdout.
  return hash(JSON.stringify([sql.serverUuid, sql.databaseName, redisRunId, redisDb]));
}

async function seed(db, redis, config, binding) {
  const createdAt = Math.floor(Date.now() / 1000);
  const ownerProof = crypto.randomBytes(32).toString('hex');
  const ledger = { version: 1, runId: config.runId, commit: EXPECTED_COMMIT, binding,
    id: crypto.randomBytes(16).toString('hex'), ownerProof, ownerHash: hash(ownerProof),
    secretHash: hash(crypto.randomBytes(32).toString('hex')), audience: ORIGIN,
    createdAt, expiresAt: createdAt + 300, ticketPreAbsent: false, ownerLockPreAbsent: false,
    insertAttempted: false, insertAcknowledged: false, cleaned: false };
  const collision = await db.one('SELECT COUNT(*) AS count FROM admin_scan_login_ticket WHERE id=? OR owner_hash=? OR secret_hash=?', [ledger.id, ledger.ownerHash, ledger.secretHash]);
  if (Number(collision?.count) !== 0 || Number(await redis.command(['EXISTS', ownLock(ledger)])) !== 0) fail('fixture-marker-already-exists');
  ledger.ticketPreAbsent = true;
  ledger.ownerLockPreAbsent = true;
  persist(config, ledger, true);
  return ledger;
}
async function insertPending(db, config, ledger) {
  ledger.insertAttempted = true;
  persist(config, ledger);
  // A plain INSERT is collision-sensitive. No INSERT IGNORE, REPLACE, upsert,
  // global expiration, rate-limit write, or ticket-creation endpoint participates.
  const result = await db.execute('INSERT INTO admin_scan_login_ticket (id,secret_hash,owner_hash,audience,status,created_at,expires_at) VALUES (?,?,?,?,?,?,?)',
    [ledger.id, ledger.secretHash, ledger.ownerHash, ledger.audience, 'pending', ledger.createdAt, ledger.expiresAt]);
  if (result.affectedRows !== 1) fail('fixture-insert-not-acknowledged');
  ledger.insertAcknowledged = true;
  persist(config, ledger);
  const row = await readOwned(db, ledger);
  if (!row || row.status !== 'pending') fail('fixture-pending-row-not-confirmed');
}
async function poll(backend, ledger, expected) {
  const response = await requestJson(FRONT[backend] + '/admin-api/scan-login/tickets/' + ledger.id, 'GET', ledger.ownerProof);
  if (response.status !== 200 || response.body?.status !== expected
    || Date.parse(response.body.expiresAt) !== ledger.expiresAt * 1000) fail('cross-node-ticket-state-mismatch');
}
async function exercise(db, ledger, checks, counts, assertRunning) {
  if (ledger.expiresAt - Math.floor(Date.now() / 1000) < 120) fail('fixture-lifetime-too-short');
  assertRunning(); counts.statusReads++;
  await poll('b0', ledger, 'pending'); checks.frontB0Pending = true;
  assertRunning(); counts.statusReads++;
  await poll('b1', ledger, 'pending'); checks.frontB1Pending = true;
  assertRunning(); counts.cancellations++;
  const response = await requestJson(FRONT.b1 + '/admin-api/scan-login/tickets/' + ledger.id + '/cancel', 'POST', ledger.ownerProof);
  if (response.status !== 200 || response.body?.status !== 'cancelled') fail('cross-node-cancel-failed');
  checks.frontB1Cancel = true;
  assertRunning(); counts.statusReads++;
  await poll('b0', ledger, 'cancelled'); checks.frontB0Cancelled = true;
  assertRunning(); counts.statusReads++;
  await poll('b1', ledger, 'cancelled'); checks.frontB1Cancelled = true;
  const row = await readOwned(db, ledger);
  if (!row || row.status !== 'cancelled') fail('cancelled-row-not-bound-to-fixture');
  checks.exactOwnedCancelledRow = true;
}
async function cleanup(db, redis, config, ledger, save = persist) {
  validateLedger(config, ledger);
  const result = { ownedTicketRemoved: false, ticketAbsent: false, ownerLockAbsent: false,
    insertOutcomeResolved: !ledger.insertAttempted || ledger.insertAcknowledged === true || ledger.insertOutcomeResolved === true,
    complete: false };
  // Also run after an ambiguous INSERT result: existence plus all exact immutable
  // markers establish ownership, rather than an optimistic local created flag.
  const row = await readOwned(db, ledger);
  if (row) {
    if (!ledger.insertAttempted) fail('unexpected-ticket-before-insert');
    // Observing the exact owned row proves the one INSERT committed. Persist
    // that evidence BEFORE deletion so interruption cannot erase its receipt.
    ledger.insertOutcomeResolved = true;
    result.insertOutcomeResolved = true;
    save(config, ledger);
    const removed = await db.execute('DELETE FROM admin_scan_login_ticket WHERE id=? AND owner_hash=? AND secret_hash=? AND audience=? AND created_at=? AND expires_at=? AND approved_user_id IS NULL AND approved_at IS NULL AND consumed_at IS NULL AND status IN (?,?,?)',
      [ledger.id, ledger.ownerHash, ledger.secretHash, ledger.audience, ledger.createdAt, ledger.expiresAt, 'pending', 'cancelled', 'expired']);
    if (removed.affectedRows !== 1) fail('fixture-delete-ownership-check-failed');
    result.ownedTicketRemoved = true;
  }
  result.ticketAbsent = !(await db.one('SELECT id FROM admin_scan_login_ticket WHERE id=? OR owner_hash=? OR secret_hash=? LIMIT 1', [ledger.id, ledger.ownerHash, ledger.secretHash]));
  // cancel's own finally uses compare-token DEL. Never delete an unexpected
  // server-generated lease token. If an interrupted request still holds it,
  // preserve the private ledger and rerun --cleanup after its 120-second TTL.
  for (let attempt = 0; attempt < 5; attempt++) {
    result.ownerLockAbsent = Number(await redis.command(['EXISTS', ownLock(ledger)])) === 0;
    if (result.ownerLockAbsent) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  // One absent read after a lost INSERT acknowledgement cannot exclude an
  // in-flight commit. Keep recovery required until the exact row is observed,
  // or the successful INSERT acknowledgment is already durably recorded.
  result.complete = result.ticketAbsent && result.ownerLockAbsent && result.insertOutcomeResolved;
  ledger.cleaned = result.complete;
  save(config, ledger);
  return result;
}

async function selfTest() {
  const ledger = { version: 1, runId: 'codex_scan_synthetic_1234', commit: EXPECTED_COMMIT,
    binding: 'f'.repeat(64), id: 'a'.repeat(32), ownerProof: 'b'.repeat(64),
    ownerHash: hash('b'.repeat(64)), secretHash: 'c'.repeat(64), audience: ORIGIN,
    createdAt: 100, expiresAt: 400, ticketPreAbsent: true, ownerLockPreAbsent: true, insertAttempted: true };
  validateLedger({ runId: ledger.runId }, ledger);
  const row = { id: ledger.id, owner_hash: ledger.ownerHash, secret_hash: ledger.secretHash,
    audience: ORIGIN, created_at: 100, expires_at: 400, status: 'pending', approved_user_id: null, approved_at: null, consumed_at: null };
  assert(ownsRow(row, ledger));
  for (const changed of ['id', 'owner_hash', 'secret_hash', 'audience', 'created_at', 'expires_at', 'approved_user_id', 'approved_at', 'consumed_at', 'status']) {
    assert(!ownsRow({ ...row, [changed]: 'foreign' }, ledger));
  }
  await assert.rejects(readOwned({ one: async () => ({ ...row, secret_hash: 'foreign' }) }, ledger), /fixture-ownership-changed/);
  assert.throws(() => configuration({}, []), /explicit-fixture-write-opt-in-required/);
  assert.throws(() => configuration({ RUN_SCAN_CLUSTER_ACCEPTANCE: '1', ACCEPTANCE_EXPECTED_NODE_COMMIT: EXPECTED_COMMIT, GIT_COMMIT: '0'.repeat(40) }, []), /approved-container-commit-required/);
  for (const endpoint of ['/admin-api/scan-login/tickets', '/admin-api/login', '/admin-api/scan-login/tickets/' + ledger.id + '/consume']) {
    assert.throws(() => requestJson(ORIGIN + '/api/backends/b0' + endpoint, 'POST', ledger.ownerProof));
  }
  const config = { runId: ledger.runId };
  let liveRow = { ...row }, deletes = 0, commands = 0;
  const db = { one: async () => liveRow,
    execute: async (sql, params) => {
      assert(sql.startsWith('DELETE FROM admin_scan_login_ticket WHERE id=? AND owner_hash=? AND secret_hash=? AND audience=? AND created_at=? AND expires_at=?'));
      assert.deepEqual(params.slice(0, 6), [ledger.id, ledger.ownerHash, ledger.secretHash, ORIGIN, 100, 400]);
      deletes++; liveRow = null; return { affectedRows: 1 };
    } };
  const redis = { command: async args => { assert.deepEqual(args, ['EXISTS', ownLock(ledger)]); commands++; return 0; } };
  // Simulate an INSERT whose acknowledgment was lost: exact owned postlookup,
  // not a success flag, must permit narrowly scoped recovery.
  ledger.insertAcknowledged = false;
  const recovered = await cleanup(db, redis, config, ledger, () => {});
  assert(recovered.complete && recovered.ownedTicketRemoved); assert.equal(deletes, 1);
  liveRow = { ...row, owner_hash: 'foreign' };
  await assert.rejects(cleanup(db, redis, config, ledger, () => {}), /fixture-ownership-changed/);
  assert.equal(deletes, 1);
  liveRow = null;
  const heldLock = await cleanup(db, { command: async args => { assert.equal(args[0], 'EXISTS'); return 1; } }, config, ledger, () => {});
  assert(!heldLock.complete && !heldLock.ownerLockAbsent);
  const uncertain = await cleanup(db, redis, config, { ...ledger, insertAcknowledged: false, insertOutcomeResolved: false }, () => {});
  assert(!uncertain.complete && !uncertain.insertOutcomeResolved && uncertain.ticketAbsent);
  const bindingDb = { one: async () => ({ serverUuid: 'synthetic-sql-server', databaseName: 'synthetic-database' }) };
  const bindingCommands = [];
  const managedRedis = { command: async args => {
    if (args[0] === 'CLIENT') throw new Error('synthetic-managed-redis-does-not-support-client-info');
    assert.deepEqual(args, ['INFO', 'server']); bindingCommands.push(args);
    return 'redis_version:synthetic\r\nrun_id:' + 'd'.repeat(40) + '\r\n';
  } };
  const bindingZero = await targetBinding(bindingDb, managedRedis, { database: 0 });
  assert.equal(bindingZero, hash(JSON.stringify(['synthetic-sql-server', 'synthetic-database', 'd'.repeat(40), 0])));
  assert.notEqual(bindingZero, await targetBinding(bindingDb, managedRedis, { database: 1 }));
  for (const options of [{ url: 'redis://synthetic.invalid/0', database: 0 }, { database: '0' }, { database: -1 }, { database: 1.5 }]) {
    await assert.rejects(targetBinding(bindingDb, managedRedis, options), /redis-(?:url-binding-not-supported|database-binding-invalid)/);
  }
  assert.equal(bindingCommands.length, 2);
  console.log(JSON.stringify({ passed: true, syntheticOnly: true, ownershipGuards: 11, configurationGuards: 2,
    forbiddenEndpointGuards: 3, ambiguousInsertRecoveryVerified: true, foreignRowPreserved: true, unexpectedRedisLeasePreserved: true,
    unknownInsertOutcomeRemainsUnresolved: true, unsupportedClientInfoAvoided: true, exactRedisDatabaseBindingVerified: true,
    redisBindingConfigurationGuards: 4, fixtureDeletes: deletes, redisReadCommands: commands }));
}

async function main() {
  const config = configuration(process.env, process.argv.slice(2));
  if (config.mode === '--self-test') return selfTest();
  const summary = { passed: false, cleanupOnly: config.mode === '--cleanup', checks: {}, counts: { insertedTickets: 0, statusReads: 0, cancellations: 0 },
    cleanup: { complete: false }, limitations: { ticketCreationNotExecuted: true, qrGenerationNotTested: true,
      noRealApprovalOrLogin: true, noRateLimitWrites: true, noRealAccountAccess: true,
      ledgerDoesNotSurviveContainerRemoval: true, redisRestartBlocksAutomaticRecovery: true,
      aliasesAloneDoNotProveDistinctProcesses: true } };
  let db, redis, ledger, failure;
  const interrupted = () => { failure ||= new FixtureError('interrupted-cleanup-required'); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    const api = dependencies();
    if (api.canonicalOrigin() !== ORIGIN || api.adminIssuer() !== ORIGIN) fail('shared-scan-origin-and-issuer-required');
    summary.checks.compiledOriginAndIssuerMatch = true;
    if (config.mode !== '--cleanup') await deploymentGate(summary.checks);
    db = new api.Database();
    const redisOptions = api.adminRedisOptions();
    redis = new api.LegacyRedis(redisOptions);
    const binding = await targetBinding(db, redis, redisOptions);
    await schemaGate(db);
    summary.checks.triggerMetadataVisibilityConfirmed = true;
    summary.checks.ticketTableHasNoTriggersOrIncomingReferences = true;
    if (config.mode === '--cleanup') {
      const recovered = loadLedger(config);
      if (recovered.binding !== binding) fail('recovery-target-binding-mismatch');
      ledger = recovered;
    } else {
      ledger = await seed(db, redis, config, binding);
      summary.checks.randomMarkersAndOwnerLockPreAbsent = true;
      if (failure) throw failure;
      await insertPending(db, config, ledger);
      summary.counts.insertedTickets = 1;
      if (failure) throw failure;
      await exercise(db, ledger, summary.checks, summary.counts, () => { if (failure) throw failure; });
    }
  } catch (error) { failure ||= error; }
  finally {
    if (db && redis && ledger) {
      try {
        summary.cleanup = await cleanup(db, redis, config, ledger);
        if (!summary.cleanup.complete) failure ||= new FixtureError('cleanup-not-yet-complete');
      } catch (error) { failure ||= error; }
    }
    for (const resource of [redis, db]) if (resource) {
      try { await resource.close(); } catch { failure ||= new FixtureError('resource-close-failed'); }
    }
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  }
  summary.passed = !failure && summary.cleanup.complete;
  if (failure) summary.errorCode = codeOf(failure);
  console.log(JSON.stringify(summary));
  if (!summary.passed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => {
  console.log(JSON.stringify({ passed: false, errorCode: codeOf(error), writesStarted: false }));
  process.exitCode = 1;
});
module.exports = { configuration, validateLedger, ownsRow, readOwned };
