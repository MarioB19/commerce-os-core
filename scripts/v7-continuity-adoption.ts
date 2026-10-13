/** V7 cutover: adopt already-authorized commercial assignments as permanent
 * continuity grants (ADR-V7-03). Run with the migration owner connection
 * (admin.env) after the V7 migrations, inside the installation window.
 *
 *   node --import tsx scripts/v7-continuity-adoption.ts plan
 *   node --import tsx scripts/v7-continuity-adoption.ts apply <plan_sha256>
 *
 * `plan` changes nothing. `apply` re-plans in one transaction and refuses a plan
 * that differs from the reviewed digest. Output holds identifiers and reason
 * codes only: no phone, contact, message or credential. */
import pg from 'pg';
import {planContinuityAdoption,applyContinuityAdoption,adoptionPlanDigest} from '../packages/db/src/continuity-adoption.js';

const [command,reviewed]=process.argv.slice(2);
if(command!=='plan'&&!(command==='apply'&&/^[a-f0-9]{64}$/.test(reviewed??''))){process.stderr.write('USAGE_PLAN_OR_APPLY_DIGEST\n');process.exit(2);}
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try{
 await client.query('BEGIN');
 if(command==='plan'){
  const plan=await planContinuityAdoption(client);
  await client.query('ROLLBACK');
  process.stdout.write(JSON.stringify({plan_sha256:adoptionPlanDigest(plan),candidates:plan.candidates.length,excluded:plan.excluded,already_adopted:plan.already_adopted,plan})+'\n');
 }else{
  const result=await applyContinuityAdoption(client,reviewed!);
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify(result)+'\n');
 }
}catch(error){
 await client.query('ROLLBACK').catch(()=>undefined);
 const message=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'CONTINUITY_ADOPTION_FAILED';
 process.stderr.write(message+'\n');process.exitCode=1;
}finally{await client.end();}
