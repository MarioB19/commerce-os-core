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

/** A REAL connected number retired through the V7 quota path: it is admitted
 * first, then stopped, unverified and paused before `deleted_at` is set. V7
 * refuses to insert an already retired number (PROFILE_QUOTA_RETIRED_INSERT_FORBIDDEN). */
export async function retiredRealAccount(db:QueryExecutor,workspace:string,body:Body):Promise<DomainRecord>{
 const {deleted_at:_deleted,...active}=body;
 const account=await putRecord(db,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{...active,status:'STOPPED',sending_enabled:false,identity_verified:false}});
 await db.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'Synthetic retirement','fixture')",[workspace,account.id]);
 return putRecord(db,{id:account.id,version:account.version,workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{...account.body,deleted_at:typeof body.deleted_at==='string'?body.deleted_at:new Date().toISOString()}});
}
