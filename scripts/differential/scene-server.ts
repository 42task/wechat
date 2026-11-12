import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const runtime=resolve('runtime/parity-validation');
const server=createServer({key:readFileSync(resolve(runtime,'scene-key.pem')),cert:readFileSync(resolve(runtime,'scene-cert.pem'))},(req,res)=>{
  const url=new URL(req.url||'/', 'https://127.0.0.1:19999');
  if(url.pathname!=='/v1/server/checkin'){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':'application/json','X-Pagination-Total-Count':'2','X-Pagination-Page-Count':'1','X-Pagination-Current-Page':'1','X-Pagination-Per-Page':'15'});
  res.end(JSON.stringify([{verse_id:3,name:'Parity scene',description:'Local fixture',category:'test'},{verse_id:4,name:'Second scene',description:'',category:''}]));
});
server.listen(19999,'127.0.0.1',()=>console.log('Local HTTPS Y1 fixture on 127.0.0.1:19999'));
process.on('SIGTERM',()=>server.close());process.on('SIGINT',()=>server.close());
