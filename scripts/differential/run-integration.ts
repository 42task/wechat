import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
async function main() {
  const c=JSON.parse(readFileSync(resolve('runtime/parity-validation/context.json'),'utf8'));
  if(process.argv.length>2) throw new Error('This validation runner accepts no database override; it uses the isolated MySQL environment.');
  const port=33368,redisPort=36380;
  const env={...c.env,MYSQL_DATABASE:'wechat_test',MYSQL_PORT:String(port),REDIS_PORT:String(redisPort),REDIS_DB:'0',RUN_INTEGRATION:'1',
    V1_MYSQL_TEST_URL:`mysql://root:wechat-local-test@127.0.0.1:${port}/wechat_schema_test`,
    JWT_SECRET:'isolated-integration-test-key-with-at-least-32-bytes'};
  delete env.PUBLIC_ORIGIN;
  const db=await mysql.createConnection({...c.mysql,port,database:'wechat_test'});
  const [tables]=await db.query<any[]>('SHOW TABLES');await db.end();
  const migration=spawnSync(process.execPath,['--import','tsx','scripts/migrate.ts',...tables.length?[]:['--bootstrap']],{env,encoding:'utf8'});
  if(migration.status!==0)throw new Error(migration.stderr);
  const name='integration-mysql';
  const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--fileParallelism=false','--reporter=json',`--outputFile=runtime/parity-validation/${name}.json`],{env,encoding:'utf8',timeout:300000,maxBuffer:10*1024*1024});
  writeFileSync(resolve(`runtime/parity-validation/${name}.log`),result.stdout+'\n'+result.stderr);
  console.log(`${name}: exit ${result.status}; see runtime/parity-validation/${name}.json`);
  process.exitCode=result.status??1;
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});
