import { describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const run = promisify(execFile);
type Migrate = (bootstrap?: boolean) => Promise<unknown>;

async function isolatedDatabase(check: (connection: mysql.Connection, migrate: Migrate) => Promise<void>): Promise<void> {
  if (!['127.0.0.1', 'localhost'].includes(process.env.MYSQL_HOST || '') || process.env.MYSQL_DATABASE !== 'wechat_test') {
    throw new Error('Device type migration tests require the dedicated localhost test database');
  }
  const database = `wechat_device_type_test_${randomBytes(12).toString('hex')}`;
  const connection = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, dateStrings: true });
  let created = false;
  try {
    await connection.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
    created = true;
    await connection.changeUser({ database });
    const migrate: Migrate = (bootstrap = false) => run(process.execPath,
      ['--import', 'tsx', 'scripts/migrate.ts', ...(bootstrap ? ['--bootstrap'] : [])],
      { cwd: resolve('.'), env: { ...process.env, MYSQL_DATABASE: database } });
    await check(connection, migrate);
  } finally {
    if (created) await connection.query(`DROP DATABASE ${database}`);
    await connection.end();
  }
}

describe.skipIf(process.env.RUN_INTEGRATION !== '1')('device type MySQL migration', () => {
  it('defaults existing devices to ios, preserves their data and retains explicit types on repeated upgrades', async () => {
    await isolatedDatabase(async (connection, migrate) => {
      const schema = (await readFile(resolve('database/legacy-schema.sql'), 'utf8'))
        .replace(/^\s*--.*$/gm, '').split(';').map(sql => sql.trim()).filter(Boolean);
      for (const sql of schema) await connection.query(sql);
      await connection.query("INSERT INTO device (id,uuid,tag,ip,version,created_at,updated_at) VALUES (7,'existing-device','preserve','127.0.0.1',15,'2026-01-01 01:02:03','2026-01-02 01:02:03')");
      const [before] = await connection.query<mysql.RowDataPacket[]>('SELECT * FROM device WHERE id=7');
      await migrate();
      const [after] = await connection.query('SELECT * FROM device WHERE id=7');
      expect(after).toEqual([{ ...before[0], shop_id: null, device_type: 'ios' }]);
      const [columns] = await connection.query<mysql.RowDataPacket[]>("SHOW COLUMNS FROM device LIKE 'device_type'");
      expect(columns).toHaveLength(1);
      expect(columns[0]).toMatchObject({ Type: 'varchar(32)', Null: 'NO', Default: 'ios' });
      await connection.query("INSERT INTO device (id,uuid) VALUES (8,'default-device')");
      await connection.query("INSERT INTO device (id,uuid,device_type) VALUES (9,'explicit-device','rokid')");
      const [types] = await connection.query('SELECT id,device_type FROM device ORDER BY id');
      expect(types).toEqual([{ id: 7, device_type: 'ios' }, { id: 8, device_type: 'ios' }, { id: 9, device_type: 'rokid' }]);
      await connection.query("UPDATE device SET device_type='rokid' WHERE id=7");
      const [configured] = await connection.query('SELECT * FROM device ORDER BY id');
      await migrate();
      const [repeated] = await connection.query('SELECT * FROM device ORDER BY id');
      expect(repeated).toEqual(configured);
      await expect(connection.query("INSERT INTO device (uuid,device_type) VALUES ('invalid-device',NULL)"))
        .rejects.toMatchObject({ code: 'ER_BAD_NULL_ERROR' });
    });
  }, 20000);

  it('adds the same default when bootstrapping an empty database', async () => {
    await isolatedDatabase(async (connection, migrate) => {
      await migrate(true);
      await connection.query("INSERT INTO device (id,uuid) VALUES (1,'bootstrap-default')");
      await connection.query("INSERT INTO device (id,uuid,device_type) VALUES (2,'bootstrap-rokid','rokid')");
      const [types] = await connection.query('SELECT id,device_type FROM device ORDER BY id');
      expect(types).toEqual([{ id: 1, device_type: 'ios' }, { id: 2, device_type: 'rokid' }]);
    });
  }, 20000);
});
