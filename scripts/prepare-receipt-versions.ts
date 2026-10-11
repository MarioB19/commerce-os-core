import {pool} from '../packages/db/src/index.js';
import {proposeReceiptTransition} from '../packages/domain/src/sales/receipt-transition.js';
import {writeFile} from 'node:fs/promises';
const workspace=process.env.WORKSPACE_ID,environment=process.argv[2]??'SIMULATION',destination=process.argv[3];
if(!workspace||!['SIMULATION','REAL'].includes(environment)||!destination)throw new Error('Usage: prepare-receipt-versions.ts SIMULATION|REAL /private/output.json');
const records=(await pool.query("SELECT id,kind,version,body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind IN ('offer','workflow') AND body->>'status'='PUBLISHED' AND body::text LIKE '%reconcile%'",[workspace,environment])).rows;
const allowed:Record<string,string[]>={offer:['name','currency','base_amount_minor','payment_method','payment_profile_version_id','receipt_policy_version_id','fulfillment','workflow_version_id','agent_version_id','billing_delay_seconds'],workflow:['name','description','product_id','nodes','entry_node_id','offer_version_id','agent_version_id','max_steps']};
await writeFile(destination,JSON.stringify({definition:'receipt_sales_v1',environment,mode:'PROPOSALS_ONLY',external_effects:0,proposals:records.map(r=>({previous_id:r.id,previous_version:r.version,kind:r.kind,product_id:r.body.product_id??null,body:proposeReceiptTransition(r.kind,Object.fromEntries(Object.entries(r.body).filter(([k])=>allowed[r.kind]!.includes(k))))}))},null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify({proposals:records.length,mutations:0}));await pool.end();
