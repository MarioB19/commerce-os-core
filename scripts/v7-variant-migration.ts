/** V7 cutover (RF-05.e, RF-08.d, ADR-V7-14): every existing product becomes a
 * parent with one Mexico variant whose first release pins exactly what it sells
 * today. Run with the migration owner connection (admin.env) after the V7
 * migrations and before the continuity adoption, inside the installation window.
 *
 *   node --import tsx scripts/v7-variant-migration.ts plan
 *   node --import tsx scripts/v7-variant-migration.ts apply <plan_sha256>
 *
 * `plan` changes nothing and prints counts, checksums and exceptions. `apply`
 * re-plans in one transaction and refuses a plan that differs from the
 * reviewed digest; it prints the product→variant UUID map. Identifiers and
 * reason codes only: no bank data, phone, contact or message. */
import pg from 'pg';
import {planVariantMigration,applyVariantMigration,variantMigrationDigest} from '../packages/db/src/variant-migration.js';

const [command,reviewed]=process.argv.slice(2);
if(command!=='plan'&&!(command==='apply'&&/^[a-f0-9]{64}$/.test(reviewed??''))){process.stderr.write('USAGE_PLAN_OR_APPLY_DIGEST\n');process.exit(2);}
const client=new pg.Client({connectionString:process.env.DATABASE_URL});
await client.connect();
try{
 await client.query('BEGIN');
 if(command==='plan'){
  const plan=await planVariantMigration(client);
  await client.query('ROLLBACK');
  const exceptions=plan.candidates.filter(c=>c.exceptions.length).map(c=>({workspace_id:c.workspaceId,product_id:c.productId,exceptions:c.exceptions}));
  process.stdout.write(JSON.stringify({plan_sha256:variantMigrationDigest(plan),products:plan.candidates.length,already_adopted:plan.already_adopted,
   assignments_following:plan.candidates.reduce((n,c)=>n+c.assignments.length,0),exceptions,plan})+'\n');
 }else{
  const result=await applyVariantMigration(client,reviewed!);
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify(result)+'\n');
 }
}catch(error){
 await client.query('ROLLBACK').catch(()=>undefined);
 const message=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'VARIANT_MIGRATION_FAILED';
 process.stderr.write(message+'\n');process.exitCode=1;
}finally{await client.end();}
