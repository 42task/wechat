import { readFileSync, openSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const runtime = resolve('runtime/parity-validation');
const c = JSON.parse(readFileSync(resolve(runtime, 'context.json'), 'utf8'));
const children = [
  spawn(process.execPath,['--import','tsx','scripts/differential/scene-server.ts'],{env:c.env,stdio:['ignore',openSync(resolve(runtime,'scene-http.log'),'a'),openSync(resolve(runtime,'scene-http.log'),'a')]}),
  spawn('php', ['-d','display_errors=0','-d',`curl.cainfo=${resolve(runtime,'scene-cert.pem')}`,'-S','127.0.0.1:18880','-t',resolve(c.sourceRoot,'api/web'),resolve(runtime,'router.php')], {
    env: {...c.env, MYSQL_DB:c.yii.database, REDIS_DB:String(c.yii.redisDb)}, stdio: ['ignore', openSync(resolve(runtime,'yii-http.log'),'a'), openSync(resolve(runtime,'yii-http.log'),'a')],
  }),
  spawn(process.execPath, ['scripts/differential/node-server.cjs'], {
    env: {...c.env, MYSQL_DATABASE:c.node.database, REDIS_DB:String(c.node.redisDb), PORT:'18881'}, stdio: ['ignore', openSync(resolve(runtime,'node-http.log'),'a'), openSync(resolve(runtime,'node-http.log'),'a')],
  }),
];
writeFileSync(resolve(runtime,'server-pids.json'),JSON.stringify(children.map(p=>p.pid)));
let stopping = false;
function stop() { if (stopping) return; stopping=true; for(const p of children) p.kill('SIGTERM'); setTimeout(()=>process.exit(),100).unref(); }
process.on('SIGINT',stop);process.on('SIGTERM',stop);
for(const p of children) p.on('exit',code=>{if(!stopping){console.error(`Test server exited (${code}). See local runtime logs.`);stop();process.exitCode=1;}});
async function wait() {
  for(let i=0;i<40;i++) {
    try {
      const healthy=await Promise.all([c.yii,c.node].map(async t=>(await fetch(`${t.base}/health`,{signal:AbortSignal.timeout(1500)})).status===200));
      if(healthy.every(Boolean)){console.log('Yii http://127.0.0.1:18880 and Node http://127.0.0.1:18881 are healthy on isolated databases/Redis.');return;}
    } catch {}
    await new Promise(r=>setTimeout(r,250));
  }
  console.error('Test servers did not become healthy. See runtime logs.');stop();process.exitCode=1;
}
void wait();
