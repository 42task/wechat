import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Differential } from './support';
async function main() {
  const h=new Differential();
  const snapshot=JSON.parse(readFileSync(resolve('docs/route-parity.json'),'utf8'));
  for(const t of h.targets) await h.reset(t);
  const cases=[...snapshot.routes,...snapshot.unconfiguredVerbCases,...snapshot.notFoundProbes];
  const seen=new Set<string>();
  for(const row of cases) {
    const path=row.sample, id=`${row.method} ${path}`;
    if(seen.has(id))continue;seen.add(id);
    await h.record(id,async t=>{
      const response=await h.request(t,row.method,path,['POST','PUT','PATCH'].includes(row.method)?{}:undefined);
      if(path==='/health'&&response.body) {
        // Compare availability contracts; build identity, uptime and latency are implementation-specific.
        response.body={status:response.body.status,checks:Object.fromEntries(Object.entries(response.body.checks??{}).map(([k,v]:any)=>[k,{status:v.status}]))};
      }
      return response;
    },row.sourceStatus);
  }
  const r=await h.finish('anonymous');console.log(`Anonymous route sweep: ${r.matched}/${r.total} equal, ${r.differences} differences.`);
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});
