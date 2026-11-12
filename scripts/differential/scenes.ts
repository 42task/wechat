import { Differential, type Target } from './support';
const h=new Differential();
async function seed(t:Target) {
  await h.reset(t);
  await h.sql(t,'INSERT INTO device (id,uuid,tag,version,created_at,updated_at) VALUES (1,?,?,1,?,?)',['parity-scene-device','Parity','2026-01-01 00:00:00','2026-01-01 00:00:00']);
  await h.sql(t,'INSERT INTO setup (id,device_id,title,scene_id,money,slogans,pictures,thumbs,updated_at) VALUES (1,1,?,3,0,\'[]\',\'[]\',\'[]\',?)',['Parity','2026-01-01 00:00:00']);
}
async function admin(t:Target) {
  const login=await h.request(t,'POST','/admin-api/login',{username:h.config.adminUsername,password:h.config.adminPassword});
  if(login.status!==200)throw new Error('Local fixture administrator login failed');
  return {Authorization:`Bearer ${login.body.token.accessToken}`};
}
async function main() {
  for(const [id,method,path,body] of [
    ['scenes.forward-list','GET','/v2/server/scenes',undefined],
    ['scenes.admin-catalog','GET','/admin-api/games',undefined],
    ['scenes.change-game','PUT','/admin-api/devices/1/game',{gameId:4}],
    ['scenes.configure-game-and-title','PUT','/admin-api/devices/1/configuration',{gameId:4,title:'Scene fixture'}],
    ['scenes.reject-unknown-game','PUT','/admin-api/devices/1/game',{gameId:999}],
  ] as const) await h.record(id,async t=>{
    await seed(t);const response=await h.request(t,method,path,body,await admin(t));
    if(response.body&&typeof response.body==='object'&&typeof response.body.updatedAt==='string')response.body.updatedAt='<write timestamp>';
    return {response,setup:await h.sql(t,'SELECT title,scene_id,money,slogans,pictures,thumbs FROM setup WHERE id=1')};
  },'Both backends use the same loopback-only HTTPS Y1 fixture; no real scene service is contacted.');
  const r=await h.finish('scenes');console.log(`Y1 fixture: ${r.matched}/${r.total} matched; ${r.harnessErrors} runner errors.`);
}
main().catch(async e=>{console.error(e instanceof Error?e.message:String(e));await h.close();process.exitCode=1;});
