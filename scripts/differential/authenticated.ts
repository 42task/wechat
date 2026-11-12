import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Differential, type Target } from './support';
const h=new Differential();
const adminTokens=new Map<string,string>();
async function seed(t:Target) {
  const date='2026-01-02 03:04:05';
  await h.sql(t,'INSERT IGNORE INTO player (id,tel,openId,recharge,`give`,cost,points,times,grade,created_at,updated_at) VALUES (1,?,?,100,0,0,100,0,0,?,?)',['parity-admin-player','parity-openid',date,date]);
  await h.sql(t,'INSERT IGNORE INTO user (id,unionid,openid,tel,role,created_at,updated_at) VALUES (1,?,?,?,\'root\',?,?)',['parity-owner','parity-owner-openid','15000159790',date,date]);
  await h.sql(t,'INSERT IGNORE INTO shop (id,tag,price,rate,play_time,created_at,updated_at) VALUES (1,?,10,80,60,?,?)',['parity-shop',date,date]);
  await h.sql(t,'INSERT IGNORE INTO operation (id,shop_id,pool,income,turnover) VALUES (1,1,0,0,0)');
  await h.sql(t,'INSERT IGNORE INTO device (id,uuid,tag,shop_id,version,created_at,updated_at) VALUES (1,?,?,1,1,?,?)',['parity-device','parity-device',date,date]);
  await h.sql(t,'INSERT IGNORE INTO manager (id,player_id,device_id,type) VALUES (1,1,1,\'staff\')');
  await h.sql(t,'INSERT IGNORE INTO control (id,user_id,device_id) VALUES (1,1,1)');
  await h.sql(t,'INSERT IGNORE INTO setup (id,device_id,title,scene_id,money,slogans,pictures,thumbs,updated_at) VALUES (1,1,?,3,0,\'[]\',\'[]\',\'[]\',?)',['Parity',date]);
  await h.sql(t,'INSERT IGNORE INTO file (id,`key`,user_id,unionid,price,unlocked,created_at) VALUES (1,?,1,?,0,0,?)',['parity-fixture.jpg','parity-owner',date]);
}
async function main() {
  for(const t of h.targets){await h.reset(t);await seed(t);const login=await h.request(t,'POST','/admin-api/login',{username:h.config.adminUsername,password:h.config.adminPassword});if(login.status!==200)throw new Error('Isolated administrator login failed');adminTokens.set(t.name,login.body.token.accessToken);}
  const snapshot=JSON.parse(readFileSync(resolve('docs/route-parity.json'),'utf8'));
  for(const row of snapshot.routes.filter((r:any)=>r.sourceStatus==='resolvable'&&r.action!=='options')) {
    await h.record(`${row.method} ${row.sample}`,async t=>{
      await seed(t);
      const auth=row.path.startsWith('/admin-api/')?adminTokens.get(t.name):h.token(row.path.startsWith('/v1/')?'v1-player':'v2-user');
      const headers:Record<string,string>={Authorization:`Bearer ${auth}`};
      if(row.path.startsWith('/swagger'))headers.Authorization='Basic '+Buffer.from('parity-docs:parity-docs-password').toString('base64');
      const response=await h.request(t,row.method,row.sample,['POST','PUT','PATCH'].includes(row.method)?{}:undefined,headers);
      if(row.path==='/health'&&response.body)response.body={status:response.body.status,checks:Object.fromEntries(Object.entries(response.body.checks??{}).map(([k,v]:any)=>[k,{status:v.status}]))};
      return response;
    },'Authenticated routing/precondition smoke; full valid business workflows are reported separately.');
  }
  const r=await h.finish('authenticated');console.log(`Authenticated sweep: ${r.matched}/${r.total} match; ${r.harnessErrors} harness errors.`);
}
main().catch(async e=>{console.error(e instanceof Error?e.message:String(e));await h.close();process.exitCode=1;});
