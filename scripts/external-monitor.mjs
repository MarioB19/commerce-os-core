// Install on a DIFFERENT host. The app console cannot detect its own host's total loss.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
const url=process.env.MONITOR_URL;
const path=process.env.MONITOR_STATE_FILE;
if(!url || !path) throw new Error('MONITOR_URL and MONITOR_STATE_FILE required');
const parsed=new URL(url); if(parsed.protocol!=='https:')throw new Error('HTTPS required');
let previous={state:'UNKNOWN',failures:0};
try{previous=JSON.parse(readFileSync(path,'utf8'));}catch{/* first probe */}
let healthy=false;
try{const r=await fetch(url,{signal:AbortSignal.timeout(5000),redirect:'error'});const data=await r.json();healthy=r.ok&&data.service==='api'&&data.status===(parsed.pathname.endsWith('/readyz')||parsed.pathname.endsWith('/health/ready')?'ready':'ok');}catch{/* unavailable or unexpected HTML fallback */}
const next={state:healthy?'UP':'DOWN',failures:healthy?0:previous.failures+1,checked_at:new Date().toISOString()};
mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(next),{mode:0o600});
if(next.state!==previous.state)console.log(JSON.stringify({event:'external_monitor_change',...next}));
// Exit failure integrates with the hosting monitor, without sending unapproved notifications itself.
process.exit(next.failures>=2?2:0);
