import {putRecord,withTransaction,type QueryExecutor} from '../../packages/db/src/index.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';
import {ensureProfile} from '../../packages/db/src/profile-provisioning.js';

type FixtureProfile=string|{id:string;numbers:number};
const platformNumbers=20;

/** V7 F2: every workspace a historical fixture writes to must be an adopted
 * profile (FKs, quotas). An installation admits at most three profiles and 20
 * connected numbers, so a test file uses at most three workspaces. Numbers are
 * split evenly unless a fixture names its allocation. Runs as the fixture
 * owner, outside any profile context; it never moves data between profiles. */
export async function fixtureProfiles(...profiles:FixtureProfile[]){
 await withTransaction(c=>fixtureProfilesOn(c,...profiles));
}

/** fixtureProfiles on another database's owner pool, in one transaction. */
export async function fixtureProfilesIn(pool:{connect():Promise<QueryExecutor&{release():void}>},...profiles:FixtureProfile[]){
 const c=await pool.connect();
 try{await c.query('BEGIN');await fixtureProfilesOn(c,...profiles);await c.query('COMMIT');}
 catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}finally{c.release();}
}

export async function fixtureProfilesOn(db:QueryExecutor,...profiles:FixtureProfile[]){
 const wanted=profiles.map(profile=>typeof profile==='string'?{id:profile,numbers:undefined as number|undefined}:profile);
 for(const profile of wanted)await ensureProfile(db,profile.id);
 const all=(await db.query('SELECT id,number_limit FROM profiles ORDER BY created_at,id')).rows as {id:string;number_limit:number}[];
 const named=new Map(wanted.filter(p=>p.numbers!==undefined).map(p=>[p.id,p.numbers!]));
 const free=all.filter(p=>!named.has(p.id)),left=platformNumbers-[...named.values()].reduce((a,b)=>a+b,0);
 if(left<0)throw new Error('FIXTURE_NUMBER_ALLOCATION_EXCEEDED');
 const target=new Map(all.map(p=>[p.id,named.get(p.id)??0]));
 free.forEach((p,i)=>target.set(p.id,Math.floor(left/free.length)+(i<left%free.length?1:0)));
 // Lower allocations first so the platform total never exceeds 20.
 const changes=all.filter(p=>target.get(p.id)!==p.number_limit).sort((a,b)=>(target.get(a.id)!-a.number_limit)-(target.get(b.id)!-b.number_limit));
 // A profile row is privacy-fenced: its own context authorizes the update.
 const previous=(await db.query("SELECT current_setting('app.workspace_id',true) AS workspace")).rows[0]?.workspace??'';
 for(const p of changes){await db.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true)",[p.id]);await db.query('UPDATE profiles SET number_limit=$2 WHERE id=$1',[p.id,target.get(p.id)]);}
 await db.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true)",[previous]);
}

/** Retires the quota reservations of every connected number admitted so far.
 * Test-only: lets a file with many short REAL fixtures stay within the
 * installation's 20 numbers without soft-deleting the historical records. */
export async function releaseFixtureNumbers(db:QueryExecutor){
 await db.query("UPDATE profile_quota_entries SET retired_at=clock_timestamp() WHERE kind='channel_account' AND retired_at IS NULL");
}

/** Retires an existing REAL connected number through the V7 quota path, in
 * its profile's context: ownership frozen, channel paused, stopped and
 * unverified first, then `deleted_at`. V7 refuses any other retirement. */
export async function retireRealAccount(workspace:string,accountId:string,deletedAt=new Date().toISOString()){
 await withTransaction(async c=>{
  await c.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true),pg_catalog.set_config('app.environment','REAL',true)",[workspace]);
  await c.query('UPDATE session_ownership SET frozen=true WHERE account_id=$1 AND workspace_id=$2',[accountId,workspace]);
  await c.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'Synthetic retirement','fixture') ON CONFLICT (workspace_id,scope_type,scope_id) DO UPDATE SET paused=true",[workspace,accountId]);
  await c.query("UPDATE records SET body=body||jsonb_build_object('status','STOPPED','sending_enabled',false,'identity_verified',false,'unlinked_at',$3::text)-'active_authorization_id',version=version+1 WHERE id=$1 AND workspace_id=$2 AND kind='channel_account'",[accountId,workspace,deletedAt]);
  await c.query("UPDATE records SET body=body||jsonb_build_object('deleted_at',$3::text),version=version+1 WHERE id=$1 AND workspace_id=$2 AND kind='channel_account'",[accountId,workspace,deletedAt]);
 });
}

/** A REAL connected number admitted and then retired (see retireRealAccount).
 * V7 refuses to insert an already retired number (PROFILE_QUOTA_RETIRED_INSERT_FORBIDDEN). */
export async function retiredRealAccount(db:QueryExecutor,workspace:string,body:Body):Promise<DomainRecord>{
 const {deleted_at:deleted,...active}=body;
 const account=await putRecord(db,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:active});
 await retireRealAccount(workspace,account.id,typeof deleted==='string'?deleted:undefined);
 return(await db.query('SELECT * FROM records WHERE id=$1',[account.id])).rows[0];
}

/** A synthetic second owner, so a fixture can deactivate or downgrade the acting
 * owner: V7 keeps at least one active owner per profile (PROFILE_LAST_OWNER_REQUIRED). */
export async function fixtureCoOwner(db:QueryExecutor,workspace:string):Promise<string>{
 const id='co-owner-'+crypto.randomUUID();
 await db.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[id,'Synthetic co-owner',id+'@example.test']);
 await db.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[id,workspace]);
 return id;
}
