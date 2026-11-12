import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const c=JSON.parse(readFileSync(resolve('runtime/parity-validation/context.json'),'utf8'));
for(const name of ['anonymous','authenticated','admin','v1','v2','scenes','business-interop','integrations-startup','provider-boundaries','sts-boundaries','php-numeric-oracle']) {
  console.log(`Running ${name} sequentially on isolated fixtures...`);
  const result=spawnSync(process.execPath,['--import','tsx',`scripts/differential/${name}.ts`],{env:c.env,encoding:'utf8',timeout:240000,maxBuffer:20*1024*1024});
  writeFileSync(resolve(`runtime/parity-validation/${name}.log`),result.stdout+'\n'+result.stderr);
  if(result.status!==0){console.error(`${name} runner failed (${result.status}). See runtime log.`);process.exitCode=1;break;}
  const report=JSON.parse(readFileSync(resolve(`runtime/parity-validation/${name}.json`),'utf8'));
  console.log(name==='business-interop'?`Business token immediate interoperability: ${report.allImmediateAccepted}`:`${name}: ${report.matched}/${report.total} matched; ${report.harnessErrors??0} runner errors.`);
  if(name==='business-interop'?!report.allImmediateAccepted:report.differences>0||report.harnessErrors>0)process.exitCode=1;
}
