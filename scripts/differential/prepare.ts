import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

async function main() {
  const runtime = resolve('runtime/parity-validation');
  mkdirSync(runtime, { recursive: true });
  if(existsSync(resolve(runtime,'context.json'))) {
    if(!process.argv.includes('--fresh')) throw new Error('This workspace already has a context. Reuse it, or use --fresh after recreating empty local test containers.');
    const probe=await mysql.createConnection({host:'127.0.0.1',port:33368,user:'root',password:'wechat-local-test'});
    try {
      const [present]=await probe.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?,?)',['parity_yii_20261112','parity_node_20261112']);
      if(present.length) throw new Error('--fresh never replaces existing test databases; reuse their existing context.');
    } finally {await probe.end();}
  }
  const sourceRoot = resolve('../game');
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  writeFileSync(resolve(runtime, 'admin-private.pem'), keys.privateKey, { mode: 0o600 });
  writeFileSync(resolve(runtime, 'admin-public.pem'), keys.publicKey);
  writeFileSync(resolve(runtime, 'business-key.txt'), randomBytes(48).toString('hex'), { mode: 0o600 });
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',resolve(runtime,'scene-key.pem'),'-out',resolve(runtime,'scene-cert.pem'),'-days','2','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{stdio:'pipe'});
  const context = {
    sourceRoot, origin: 'https://isolated.example', adminUsername: 'parity-admin', adminPassword: 'parity-local-password',
    jwtKey: resolve(runtime, 'business-key.txt'),
    mysql: { host: '127.0.0.1', port: 33368, user: 'root', password: 'wechat-local-test' },
    redis: { host: '127.0.0.1', port: 36380 },
    yii: { base: 'http://127.0.0.1:18880', database: 'parity_yii_20261112', redisDb: 12 },
    node: { base: 'http://127.0.0.1:18881', database: 'parity_node_20261112', redisDb: 13 },
    env: {} as Record<string,string>,
  };
  context.env = {
    PATH: process.env.PATH || '', HOME: process.env.HOME || '', TMPDIR: process.env.TMPDIR || '/private/tmp', LANG: 'en_US.UTF-8',
    NODE_ENV: 'test', HOST: '127.0.0.1', TZ: 'Asia/Shanghai', MYSQL_HOST: '127.0.0.1', MYSQL_PORT: '33368',
    MYSQL_USER: 'root', MYSQL_NAME: 'root', MYSQL_PASSWORD: 'wechat-local-test', MYSQL_CHARSET: 'utf8',
    REDIS_HOST: '127.0.0.1', REDIS_PORT: '36380', ADMIN_AUTH_REDIS_HOST: '127.0.0.1', ADMIN_AUTH_REDIS_PORT: '36380', ADMIN_AUTH_REDIS_DB: '15',
    JWT_KEY: context.jwtKey, ADMIN_JWT_KEY: resolve(runtime, 'admin-private.pem'), ADMIN_JWT_PUB_KEY: resolve(runtime, 'admin-public.pem'),
    ADMIN_USERNAME: context.adminUsername, ADMIN_PASSWORD_HASH: bcrypt.hashSync(context.adminPassword, 4),
    ADMIN_AUTH_ISSUER: context.origin, ADMIN_SCAN_LOGIN_ORIGIN: context.origin,
    SCENE_SERVER_BASE_URL: 'https://127.0.0.1:19999', NODE_EXTRA_CA_CERTS:resolve(runtime,'scene-cert.pem'), GAME_DEV_AUTH: '0',
    SWAGGER_USERNAME: 'parity-docs', SWAGGER_PASSWORD: 'parity-docs-password',
  };
  writeFileSync(resolve(runtime, 'context.json'), JSON.stringify(context, null, 2), { mode: 0o600 });
  const prefix = `<?php
error_reporting(E_ALL & ~E_DEPRECATED);
defined('YII_DEBUG') or define('YII_DEBUG', true);
defined('YII_ENV') or define('YII_ENV', 'prod');
$ctx = json_decode(file_get_contents(__DIR__ . '/context.json'), true);
$api = $ctx['sourceRoot'] . '/api';
require $api . '/vendor/autoload.php';
require $api . '/vendor/yiisoft/yii2/Yii.php';
`;
  const database = `$config['basePath'] = $api;
$config['runtimePath'] = __DIR__ . '/yii-runtime';
$config['components']['db'] = ['class'=>'yii\\db\\Connection', 'dsn'=>'mysql:host=127.0.0.1;port=33368;dbname='.$ctx['yii']['database'], 'username'=>'root', 'password'=>'wechat-local-test', 'charset'=>'utf8'];
`;
  writeFileSync(resolve(runtime, 'console.php'), prefix + `$config = require $ctx['sourceRoot'] . '/files/api/config/console.php';\n` + database + `$app = new yii\\console\\Application($config); exit($app->run());\n`);
  writeFileSync(resolve(runtime, 'router.php'), prefix + `$_SERVER['SCRIPT_NAME']='/index.php';
$_SERVER['SCRIPT_FILENAME']=$api . '/web/index.php';
$config = require $ctx['sourceRoot'] . '/files/api/config/web.php';
` + database + `$config['components']['request']['scriptFile'] = $api . '/web/index.php';
$config['components']['request']['scriptUrl'] = '/index.php';
Yii::setAlias('@app', $api);
$stsFixture = require dirname(__DIR__, 2) . '/scripts/differential/sts-http-fixture.php';
$stsFixture($api, $config);
$transport = require dirname(__DIR__, 2) . '/scripts/differential/scene-transport.php';
$config['controllerMap']['admin'] = ['class'=>'app\\controllers\\AdminController', 'catalog'=>new app\\components\\AdminGameCatalog(['fetcher'=>new app\\components\\AdminSceneFetcher(['transport'=>$transport]), 'cache'=>new yii\\caching\\FileCache(['cachePath'=>__DIR__.'/yii-runtime/admin-scenes-cache'])])];
Yii::$container->set('app\\components\\AdminGameCatalog', static function () use ($transport) { return new app\\components\\AdminGameCatalog(['fetcher'=>new app\\components\\AdminSceneFetcher(['transport'=>$transport]), 'cache'=>new yii\\caching\\FileCache(['cachePath'=>__DIR__.'/yii-runtime/admin-scenes-cache'])]); });
$app = new yii\\web\\Application($config); $app->run();
`);
  mkdirSync(resolve(runtime, 'yii-runtime'), { recursive: true });
  const connection = await mysql.createConnection(context.mysql);
  try {
    for (const name of [context.yii.database, context.node.database]) {
      const [existing] = await connection.query<any[]>('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [name]);
      if (existing.length) throw new Error(`Test database already exists: ${name}; reuse the prepared context instead of recreating it.`);
      await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
    }
    const yiiEnv = { ...context.env, MYSQL_DB: context.yii.database, MYSQL_DATABASE: context.yii.database, REDIS_DB: String(context.yii.redisDb) };
    execFileSync('php', [resolve(runtime, 'console.php'), 'migrate', '--interactive=0'], { env: yiiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const [schema] = await connection.query('SELECT TABLE_NAME,COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,CHARACTER_SET_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,ORDINAL_POSITION', [context.yii.database]);
    writeFileSync(resolve(runtime, 'yii-schema-before-node-upgrade.json'), JSON.stringify(schema, null, 2));
    // The differential suite uses the same post-cutover schema on both sides.
    // Preserve the untouched Yii schema above so compatibility columns are not hidden.
    for (const target of [context.yii, context.node]) {
      const env = { ...context.env, MYSQL_DATABASE: target.database, REDIS_DB: String(target.redisDb) };
      const args = ['--import', 'tsx', 'scripts/migrate.ts', ...(target === context.node ? ['--bootstrap'] : [])];
      execFileSync(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    console.log('Prepared two isolated databases, temporary signing keys and production-mode Yii router.');
  } finally { await connection.end(); }
}
main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
