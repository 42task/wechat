/**
 * Local-only old-main -> Node schema rehearsal.
 * Run from the repository root:
 *   env -i PATH="$PATH" node --import tsx scripts/legacy-differential/schema-rehearsal.ts
 * Requires the frozen c4e088a archive and the disposable MySQL at 127.0.0.1:33368.
 * Never loads project .env/config, accepts no target overrides, and drops only a
 * database for which this invocation's collision-sensitive CREATE succeeded.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';

const run = promisify(execFile);
const root = resolve(__dirname, '../..');
const output = resolve(root, 'runtime/legacy-main-source-20261112');
const source = resolve(output, 'source');
const commit = 'c4e088adc7ba17bd5bb640ac31178a122906e002';
const fixtureDatabase = `parity_legacy_upgrade_${randomBytes(12).toString('hex')}`;
const local = { host: '127.0.0.1', port: 33368, user: 'root', password: 'wechat-local-test' };
const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test' };
type Row = Record<string, unknown>;
interface Schema { tables: Row[]; columns: Row[]; indexes: Row[]; foreignKeys: Row[]; }
interface Snapshot { schema: Schema; rows: Record<string, Row[]>; }
interface Manifest { commit: string; files: { path: string; sha256: string }[]; }

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function identifier(name: string): string {
  assert.match(name, /^[a-zA-Z_][a-zA-Z0-9_]*$/);
  return '`' + name + '`';
}
function guardTarget(): void {
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.port, 33368);
  assert.match(fixtureDatabase, /^parity_legacy_upgrade_[0-9a-f]{24}$/);
  assert.equal(process.argv.length, 2, 'This rehearsal accepts no target or configuration arguments.');
  assert.equal(resolve(process.cwd()), root, 'Run this script from the repository root.');
}
async function query(db: Connection, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<RowDataPacket[]>(sql, params))[0] as Row[];
}
async function schema(db: Connection): Promise<Schema> {
  // Exclude volatile cardinality and AUTO_INCREMENT counters from structure comparisons.
  const tables = await query(db, 'SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [fixtureDatabase]);
  const columns = await query(db, 'SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, ORDINAL_POSITION AS position, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME, ORDINAL_POSITION', [fixtureDatabase]);
  const indexes = await query(db, 'SELECT TABLE_NAME AS tableName, INDEX_NAME AS name, SEQ_IN_INDEX AS position, COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique, SUB_PART AS prefixLength, INDEX_TYPE AS type FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', [fixtureDatabase]);
  const foreignKeys = await query(db, 'SELECT k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS columnName, k.ORDINAL_POSITION AS position, k.REFERENCED_TABLE_NAME AS referencedTable, k.REFERENCED_COLUMN_NAME AS referencedColumn, r.DELETE_RULE AS onDelete, r.UPDATE_RULE AS onUpdate FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=? ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION', [fixtureDatabase]);
  return { tables, columns, indexes, foreignKeys };
}
async function snapshot(db: Connection, structure?: Schema): Promise<Snapshot> {
  const current = structure ?? await schema(db);
  const rows: Record<string, Row[]> = {};
  for (const table of current.tables) {
    const name = String(table.name);
    const primary = current.indexes.filter(index => index.tableName === name && index.name === 'PRIMARY');
    assert.ok(primary.length, `Fixture table ${name} must have a primary key for deterministic snapshots.`);
    rows[name] = await query(db, `SELECT * FROM ${identifier(name)} ORDER BY ${primary.map(index => identifier(String(index.columnName))).join(',')}`);
  }
  return { schema: current, rows };
}
function difference(before: Row[], after: Row[], fields: string[]) {
  const key = (row: Row) => fields.map(field => String(row[field])).join('.');
  const old = new Map(before.map(row => [key(row), row]));
  const next = new Map(after.map(row => [key(row), row]));
  return {
    added: after.filter(row => !old.has(key(row))),
    removed: before.filter(row => !next.has(key(row))),
    changed: before.flatMap(row => {
      const following = next.get(key(row));
      return following && canonical(row) !== canonical(following) ? [{ before: row, after: following }] : [];
    }),
  };
}
function structureDifference(before: Schema, after: Schema) {
  return {
    tables: difference(before.tables, after.tables, ['name']),
    columns: difference(before.columns, after.columns, ['tableName', 'name']),
    indexes: difference(before.indexes, after.indexes, ['tableName', 'name', 'position']),
    foreignKeys: difference(before.foreignKeys, after.foreignKeys, ['tableName', 'name', 'position']),
  };
}
function preservedRows(before: Snapshot, after: Snapshot) {
  return Object.entries(before.rows).map(([table, rows]) => {
    const columns = before.schema.columns.filter(column => column.tableName === table).map(column => String(column.name));
    assert.ok(after.rows[table], `Missing legacy table ${table}`);
    const projection = after.rows[table].map(row => Object.fromEntries(columns.map(column => [column, row[column]])));
    assert.equal(canonical(projection), canonical(rows), `Existing values changed in ${table}`);
    return { table, columns: columns.length, rows: rows.length, beforeSha256: hash(canonical(rows)), afterSha256: hash(canonical(projection)), preserved: true };
  });
}
async function seed(db: Connection): Promise<void> {
  const created = '2026-01-02 03:04:05';
  const updated = '2026-02-03 04:05:06';
  const insert = async (table: string, row: Row) => {
    const columns = Object.keys(row);
    await db.query(`INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')}) VALUES (${columns.map(() => '?').join(',')})`, Object.values(row));
  };
  await insert('shop', { id: 5, tag: 'synthetic-old-shop', created_at: created, updated_at: updated, rate: 88, price: 199, play_time: 75, advanced: 1 });
  await insert('device', { id: 7, uuid: 'synthetic-old-device', tag: 'synthetic-camera-01', ip: '192.0.2.7', created_at: created, updated_at: updated });
  await insert('user', { id: 8, unionid: 'synthetic-union', openid: 'synthetic-user-openid', tel: 'synthetic-user-tel', nickname: '历史用户', avatar: 'https://example.invalid/user.png', created_at: created, updated_at: updated, role: 'manager' });
  await insert('player', { id: 9, tel: 'synthetic-player-tel', nickname: '历史玩家', recharge: 123.5, cost: 17.25, times: 3, grade: 2, points: 81, created_at: created, updated_at: updated, openId: 'synthetic-player-openid', avatar: 'https://example.invalid/player.png', info: '{"synthetic":true,"nested":[null,1,"中文"]}', give: 6 });
  await insert('record', { id: 10, player_id: 9, device_id: 7, created_at: created, updated_at: updated, startTime: '2026-01-02 03:05:00', endTime: '2026-01-02 03:06:00', status: 'finish', game: '{"synthetic":true,"score":42.5,"unlocked":false}' });
  for (const unlocked of [0, 1]) await insert('file', { id: 11 + unlocked, unionid: 'synthetic-union', key: `synthetic/history-${unlocked}.mp4`, type: 'video/mp4', md5: String(unlocked).repeat(32), size: 1048576 + unlocked, bucket: 'synthetic-history', created_at: created, unlocked, title: `历史文件${unlocked}`, user_id: 8 });
  await insert('daily', { id: 13, shop_id: 5, income: 123.5, expenses: 17.25, date: '2026-01-02' });
  await insert('award', { id: 14, shop_id: 5, price: 250, type: 'm' });
  await insert('gift', { id: 15, award_id: 14, info: '{"synthetic":true}', created_at: created, updated_at: updated, uuid: 'synthetic-gift', tag: '历史奖品', picture: 'https://example.invalid/gift.png' });
  await insert('gain', { id: 16, player_id: 9, shop_id: 5, created_at: created, updated_at: updated, type: 'synthetic-award', gift_id: 15, uuid: 'synthetic-gain' });
  await insert('manager', { id: 17, player_id: 9, type: 'staff', device_id: 7 });
  await insert('player_token', { id: 18, player_id: 9, created_at: created, updated_at: updated, expires_at: '2026-12-31 23:59:59', refresh_token: 'synthetic-nonsecret-refresh-token' });
  await insert('operation', { id: 19, shop_id: 5, pool: 100, income: 70, turnover: 170 });
  await insert('checkin_recode', { id: 20, key: 'synthetic-checkin', openid: 'synthetic-checkin-openid', unionid: 'synthetic-union', token: 'synthetic-nonsecret-checkin-token', created_at: created });
  await insert('control', { id: 21, user_id: 8, device_id: 7 });
  await insert('setup', { id: 22, money: 1.99, slogans: '["synthetic","历史"]', pictures: '["https://example.invalid/picture.png"]', thumbs: '[]', title: '历史设置', scene_id: 99, device_id: 7, shots: '{"count":3}', updated_at: updated });
}

async function main(): Promise<void> {
  guardTarget();
  await mkdir(output, { recursive: true });
  const report: Record<string, any> = {
    startedAt: new Date().toISOString(), sourceCommit: commit,
    target: { host: local.host, port: local.port, database: fixtureDatabase },
    fixture: 'Entirely synthetic; no project .env, Yii config, real keys, Redis, HTTP or external service is used.',
    cleanup: { created: false, dropped: false, verifiedAbsent: false },
    limitations: [
      'An isolated fixture exercises the final state of all 61 old migrations; it is not a copy of an actual deployed database.',
      'Yii migration history is synthetic bookkeeping matching the inspected frozen Yii controller, not evidence of a live migration run.',
      'Historical device-to-shop mappings were removed by the old Yii schema; Node can add only a nullable shop_id, not reconstruct that mapping.',
      'This validates schema/data preservation and repeatability, not HTTP/provider behavior, large-table timing, locking, or production rollout.',
    ],
  };
  let db: Connection | undefined;
  let created = false;
  let failure: unknown;
  try {
    const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8')) as Manifest;
    assert.equal(manifest.commit, commit, 'Wrong frozen baseline.');
    const files = (await readdir(resolve(source, 'api/migrations'))).filter(name => /^m.*\.php$/.test(name)).sort();
    assert.equal(files.length, 61, 'Expected the actual old main, with 61 migrations.');
    const controllerPath = 'api/vendor/yiisoft/yii2/console/controllers/MigrateController.php';
    const basePath = 'api/vendor/yiisoft/yii2/console/controllers/BaseMigrateController.php';
    const verified = [];
    for (const path of [...files.map(name => `api/migrations/${name}`), controllerPath, basePath]) {
      const entry = manifest.files.find(file => file.path === path);
      assert.ok(entry, `Frozen manifest lacks ${path}`);
      const bytes = await readFile(resolve(source, path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `Frozen source changed: ${path}`);
      verified.push({ path, sha256: entry.sha256 });
    }
    const controller = await readFile(resolve(source, controllerPath), 'utf8');
    const base = await readFile(resolve(source, basePath), 'utf8');
    assert.match(controller, /const MAX_NAME_LENGTH = 180;/);
    assert.ok(controller.includes("public $migrationTable = '{{%migration}}';"));
    assert.ok(controller.includes("'version' => 'varchar(' . static::MAX_NAME_LENGTH . ') NOT NULL PRIMARY KEY'"));
    assert.ok(controller.includes("'apply_time' => 'integer'"));
    assert.ok(controller.includes("'version' => self::BASE_MIGRATION"));
    assert.ok(base.includes("const BASE_MIGRATION = 'm000000_000000_base';"));
    const generated = await run('php', ['-n', 'scripts/generate-legacy-schema.php', resolve(source, 'api/migrations')], { cwd: root, env: childEnv, maxBuffer: 1024 * 1024, timeout: 15000 });
    assert.equal(generated.stderr, '');
    const oldSchema = generated.stdout;
    assert.ok(oldSchema.includes('-- 61 ordered migrations;'));
    await writeFile(resolve(output, 'schema-rehearsal-old.sql'), oldSchema);
    report.baseline = { migrations: files.length, schemaSha256: hash(oldSchema), verifiedFrozenFiles: verified };
    db = await mysql.createConnection({ ...local, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, charset: 'utf8mb4', timezone: '+08:00', connectTimeout: 5000, multipleStatements: false });
    report.mysql = (await query(db, 'SELECT VERSION() AS version, @@version_comment AS distribution, @@sql_mode AS sqlMode'))[0];
    // Deliberately omit IF NOT EXISTS. A collision must never authorize reuse/drop.
    guardTarget();
    await db.query(`CREATE DATABASE ${identifier(fixtureDatabase)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    created = true;
    report.cleanup.created = true;
    await db.changeUser({ database: fixtureDatabase });
    assert.equal((await query(db, 'SELECT DATABASE() AS name'))[0].name, fixtureDatabase);
    for (const statement of oldSchema.replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean)) await db.query(statement);
    const oldStructure = await schema(db);
    assert.equal(oldStructure.tables.length, 16);
    for (const [table, column] of [['device', 'version'], ['device', 'shop_id'], ['file', 'price']]) assert.ok(!oldStructure.columns.some(item => item.tableName === table && item.name === column));
    // generate-legacy-schema records application migrations only. Reproduce the
    // separately inspected Yii migration ledger instead of altering app DDL.
    await db.query('CREATE TABLE `migration` (`version` varchar(180) NOT NULL PRIMARY KEY, `apply_time` int NULL)');
    for (const [index, version] of ['m000000_000000_base', ...files.map(name => name.slice(0, -4))].entries()) await db.query('INSERT INTO `migration` (`version`,`apply_time`) VALUES (?,?)', [version, 1700000000 + index]);
    report.migrationHistory = { source: `${controllerPath}:266`, rows: 62, base: 'm000000_000000_base', behavior: 'Node does not rewrite Yii migration history or claim its four modern Yii migrations were applied.' };
    await seed(db);
    const before = await snapshot(db);
    for (const table of oldStructure.tables) assert.ok(before.rows[String(table.name)].length > 0, `No synthetic seed for ${table.name}`);
    const migrateEnv: NodeJS.ProcessEnv = {
      ...childEnv, DOTENV_CONFIG_PATH: '/dev/null', DOTENV_CONFIG_QUIET: 'true', DOTENV_CONFIG_OVERRIDE: 'false',
      MYSQL_HOST: local.host, MYSQL_PORT: String(local.port), MYSQL_USER: local.user, MYSQL_PASSWORD: local.password,
      MYSQL_DATABASE: fixtureDatabase, MYSQL_CHARSET: 'utf8mb4', MYSQL_POOL_SIZE: '2',
    };
    const migrate = async () => {
      guardTarget();
      assert.equal(migrateEnv.MYSQL_DATABASE, fixtureDatabase);
      assert.equal(migrateEnv.MYSQL_HOST, '127.0.0.1');
      assert.equal(migrateEnv.MYSQL_PORT, '33368');
      const result = await run(process.execPath, ['--import', 'tsx', 'scripts/migrate.ts'], { cwd: root, env: migrateEnv, timeout: 30000, maxBuffer: 1024 * 1024 });
      return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: 0 };
    };
    report.firstMigration = await migrate();
    const after = await snapshot(db);
    report.legacyRows = preservedRows(before, after);
    const delta = structureDifference(before.schema, after.schema);
    report.schemaDelta = delta;
    assert.equal(delta.tables.removed.length, 0);
    assert.equal(delta.tables.changed.length, 0);
    assert.equal(delta.columns.removed.length, 0);
    assert.deepEqual(delta.tables.added.map(table => table.name).sort(), ['admin_scan_login_ticket', 'file_payment_order', 'node_browser_session', 'node_rate_limit']);
    assert.deepEqual(delta.columns.added.filter(column => before.rows[String(column.tableName)]).map(column => `${column.tableName}.${column.name}`).sort(), ['device.shop_id', 'device.version', 'file.price']);
    assert.equal(delta.columns.changed.length, 1);
    const changed = delta.columns.changed[0];
    assert.equal(changed.before.tableName, 'record');
    assert.equal(changed.before.name, 'device_id');
    assert.equal(changed.before.nullable, 'NO');
    assert.equal(changed.after.nullable, 'YES');
    assert.equal(canonical({ ...changed.before, nullable: 'YES' }), canonical(changed.after));
    assert.equal(delta.indexes.removed.length, 0);
    assert.equal(delta.indexes.changed.length, 0);
    assert.deepEqual(delta.indexes.added.map(index => `${index.tableName}.${index.name}`).sort(), [
      'admin_scan_login_ticket.PRIMARY', 'admin_scan_login_ticket.idx-admin-scan-login-expiry',
      'device.idx-device-shop_id', 'file_payment_order.PRIMARY',
      'node_browser_session.PRIMARY', 'node_browser_session.idx_node_session_expiry',
      'node_rate_limit.PRIMARY', 'node_rate_limit.idx_node_limit_expiry',
    ].sort());
    assert.equal(delta.foreignKeys.removed.length, 1);
    assert.equal(delta.foreignKeys.removed[0].name, 'fk-record-device_id');
    assert.equal(delta.foreignKeys.changed.length, 0);
    assert.equal(delta.foreignKeys.added.length, 2);
    const recordKey = after.schema.foreignKeys.find(key => key.tableName === 'record' && key.columnName === 'device_id');
    assert.equal(recordKey?.onDelete, 'SET NULL');
    assert.equal(recordKey?.onUpdate, delta.foreignKeys.removed[0].onUpdate, 'Preserve the actual server-reported ON UPDATE rule.');
    assert.equal(recordKey?.referencedTable, 'device');
    assert.equal(recordKey?.referencedColumn, 'id');
    for (const table of delta.tables.added) assert.equal(after.rows[String(table.name)].length, 0, `Unexpected seeded Node state in ${table.name}`);
    const paymentOrderKey = after.schema.columns.find(column => column.tableName === 'file_payment_order' && column.name === 'out_trade_no');
    assert.equal(paymentOrderKey?.collation, 'ascii_bin');
    const devices = await query(db, 'SELECT id,version,shop_id FROM device ORDER BY id');
    const prices = await query(db, 'SELECT id,unlocked,price FROM file ORDER BY id');
    assert.deepEqual(devices, [{ id: 7, version: 0, shop_id: null }]);
    assert.deepEqual(prices, [{ id: 11, unlocked: 0, price: null }, { id: 12, unlocked: 1, price: null }]);
    report.defaults = { devices, historicalFiles: prices };
    report.secondMigration = await migrate();
    const repeated = await snapshot(db);
    assert.equal(canonical(repeated), canonical(after), 'Second migration changed schema or any fixture rows.');
    report.idempotence = { schemaUnchanged: true, allTablesRowsUnchanged: true, legacyRows: preservedRows(before, repeated) };
    // Verify the new FK behavior in a transaction, then restore every fixture row.
    await db.beginTransaction();
    try {
      await db.query('DELETE FROM device WHERE id=7');
      const history = await query(db, 'SELECT * FROM record WHERE id=10');
      assert.equal(history.length, 1);
      assert.equal(canonical(history[0]), canonical({ ...after.rows.record[0], device_id: null }));
      report.deviceDelete = { recordRetained: true, onlyRecordDeviceIdBecameNull: true, transactionRolledBack: true };
    } finally { await db.rollback(); }
    assert.equal(canonical(await snapshot(db)), canonical(after), 'Device-delete rollback changed fixture data.');
    report.snapshots = { before, after, repeated };
    report.passed = true;
  } catch (error) {
    failure = error;
    report.passed = false;
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (db) {
      if (created) {
        try {
          guardTarget();
          await db.query(`DROP DATABASE ${identifier(fixtureDatabase)}`);
          report.cleanup.dropped = true;
          report.cleanup.verifiedAbsent = (await query(db, 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [fixtureDatabase])).length === 0;
          assert.equal(report.cleanup.verifiedAbsent, true);
        } catch (error) {
          failure ??= error;
          report.passed = false;
          report.cleanup.error = error instanceof Error ? error.message : String(error);
        }
      }
      try { await db.end(); } catch (error) {
        failure ??= error;
        report.passed = false;
        report.cleanup.connectionError = error instanceof Error ? error.message : String(error);
      }
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(resolve(output, 'schema-rehearsal.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  console.log(JSON.stringify({ passed: report.passed, businessTables: 16, businessRows: report.legacyRows.filter((table: { table: string }) => table.table !== 'migration').reduce((count: number, table: { rows: number }) => count + table.rows, 0), migrationHistoryRows: 62, historicalPrices: report.defaults.historicalFiles, idempotent: true, cleanup: report.cleanup, report: resolve(output, 'schema-rehearsal.json') }, null, 2));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
