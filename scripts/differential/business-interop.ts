import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import jwt from 'jsonwebtoken';
import { Differential } from './support';
const h=new Differential();
async function main() {
  for(const t of h.targets) {
    await h.reset(t);
    await h.sql(t,'INSERT INTO player (id,tel,openId,created_at,updated_at) VALUES (1,?,?,?,?)',['parity-interop','parity-interop-openid','2026-01-01 00:00:00','2026-01-01 00:00:00']);
  }
  const results:any[]=[];
  const body={openId:'parity-interop-openid',timestamp:'123',fingerprint:createHash('md5').update('geek.v0xe1.pa2ty.c0m123parity-interop-openid').digest('hex')};
  for(const issuer of h.targets) {
    const peer=h.targets.find(t=>t!==issuer)!;
    for(let attempt=0;attempt<5;attempt++) {
      const issued=await h.request(issuer,'POST','/v1/common/sign-in',body);
      const token=issued.body?.token?.accessToken??issued.body?.accessToken;
      if(typeof token!=='string') throw new Error(`Business sign-in did not issue a token (${issuer.name}/${issued.status})`);
      const claims=jwt.decode(token) as jwt.JwtPayload;
      const headers={Authorization:`Bearer ${token}`};
      const immediate=await h.request(peer,'GET','/v1/player/1?fields=id,tel',undefined,headers);
      const own=await h.request(issuer,'GET','/v1/player/1?fields=id,tel',undefined,headers);
      let delayedStatus:number|undefined;
      if(immediate.status!==200) {await new Promise(r=>setTimeout(r,1100));delayedStatus=(await h.request(peer,'GET','/v1/player/1?fields=id,tel',undefined,headers)).status;}
      results.push({issuer:issuer.name,receiver:peer.name,attempt:attempt+1,issuedStatus:issued.status,ownStatus:own.status,immediatePeerStatus:immediate.status,delayedPeerStatus:delayedStatus,
        fractionalIssuedAt:!Number.isInteger(claims.iat),fractionalNotBefore:!Number.isInteger(claims.nbf),error:immediate.status===200?undefined:immediate.body});
    }
  }
  for(const kind of ['future-within-yii-leeway','expired-within-yii-leeway']) {
    const now=Date.now()/1000;
    const claims={uid:1,identityDomain:'v1-player',iat:kind.startsWith('future')?now+5:now-3600,nbf:kind.startsWith('future')?now+5:now-3600,exp:kind.startsWith('future')?now+3600:now-5};
    const token=jwt.sign(claims,readFileSync(h.config.jwtKey),{algorithm:'HS256'});
    const statuses:Record<string,number>={};
    for(const t of h.targets)statuses[t.name]=(await h.request(t,'GET','/v1/player/1?fields=id,tel',undefined,{Authorization:`Bearer ${token}`})).status;
    results.push({case:kind,statuses});
  }
  const report={generatedAt:new Date().toISOString(),results,allImmediateAccepted:results.filter(r=>r.issuer).every(r=>r.immediatePeerStatus===200)};
  writeFileSync(resolve('runtime/parity-validation/business-interop.json'),JSON.stringify(report,null,2));
  console.log(`Business token interop: ${report.allImmediateAccepted?'PASS':'DIFFERENT'}; see business-interop.json`);
  await h.close();
}
main().catch(async e=>{console.error(e instanceof Error?e.message:String(e));await h.close();process.exitCode=1;});
