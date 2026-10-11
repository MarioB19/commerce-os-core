import {it,expect,afterAll} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {processChannelCommands,heartbeatOwnership} from '../../apps/channel-worker/src/lifecycle.js';
import {processWarmup} from '../../apps/automation-worker/src/warmup.js';
import {dispatchOutbox} from '../../apps/channel-worker/src/dispatch.js';
import {consumeProviderObservations} from '../../apps/channel-worker/src/observations.js';
import {processInbound} from '../../apps/automation-worker/src/inbound.js';
afterAll(()=>pool.end());
it('migrates a legacy private episode using days produced by the pipeline, preserving history without fabricating manual preparation',async()=>{
 const app=await createApp(),workspace='migration-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!,email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Migration fixture',email,password,workspace_id:workspace,role:'owner'});const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}}),cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 async function call(method:any,url:string,body?:any,status=200){const r=await app.inject({method,url:url+'?environment=SIMULATION',payload:body,headers:{cookie,origin,'idempotency-key':randomUUID()}});expect(r.statusCode,r.body).toBe(status);return r.json().data;}
 try{
  let clock=await call('POST','/v1/number-simulation',{action:'create',at:'2026-09-01T10:00:00.000Z'});const ids:string[]=[];
  async function observe(){for(const id of ids){const a=await call('GET','/v1/numbers/'+id);await call('POST','/v1/numbers/'+id+'/observe-identity',{expected_version:a.version},202);}await processNumberOperations();}
  for(let n=0;n<2;n++)ids.push((await call('POST','/v1/numbers',{alias:'Legado '+n,responsible:'Operador de ensayo',device_ref:'Dispositivo legado '+n},202)).id);
  await processNumberOperations();await observe();for(const id of ids){let a=await call('GET','/v1/numbers/'+id);await call('POST','/v1/numbers/'+id+'/confirm-identity',{expected_version:a.version,ownership_confirmed:true,name:a.alias,about:'Perfil de prueba de migración'});a=await call('GET','/v1/numbers/'+id);await call('POST','/v1/channel-accounts/'+id+'/commands',{type:'connect',expected_version:a.version,reason:'Simulador privado sin red'},202);}
  await processChannelCommands(20);for(const id of ids){const session=await call('GET','/v1/channel-accounts/'+id+'/session');await call('PATCH','/v1/channel-accounts/'+id+'/session',{expected_version:session.revision,operational_pause:false,reason:'Ensayo privado explícito'});}
  clock=await call('POST','/v1/number-simulation',{action:'advance',seconds:86400,expected_version:clock.version});await observe();
  const profile=await call('POST','/v1/warmup/profiles',{name:'Histórico reproducido',policy_version:'legacy-30d/v1',timezone:'UTC',start_hour:0,end_hour:23,jitter_seconds:0},201);
  let legacy=await call('POST','/v1/warmup/pools',{profile_id:profile.id,account_ids:ids,ownership_confirmed:true,allow_small_pool_concentration:true,reason:'Reproducir legado con pipeline'},201);
  const content=await call('POST','/v1/warmup/content',{label:'Conversación propia de prueba',ownership_confirmed:true,turns:Array.from({length:6},(_,i)=>({kind:'text',text:'Prueba privada de migración '+i}))},201);
  legacy=await call('POST','/v1/warmup/pools/'+legacy.id+'/authorize',{expected_version:legacy.version,confirmation:'AUTHORIZE_OWN_POOL_ONLY',content_ids:[content.id],expires_at:new Date(Date.now()+20*86400000).toISOString(),max_messages:100,allow_profile_updates:false,compatible_release_sha:'a'.repeat(40),provider_evidence:'Adaptador cerrado de prueba de migración',reason:'Sólo ensayo aislado'});
  for(let step=0;step<30;step++){await heartbeatOwnership();await observe();await processWarmup();for(let pass=0;pass<4;pass++){await dispatchOutbox(100);await processInbound(100);await consumeProviderObservations(100);}clock=await call('POST','/v1/number-simulation',{action:'advance',seconds:1800,expected_version:clock.version});}
  await observe();await processWarmup();const states=(await pool.query('SELECT * FROM warmup_states WHERE workspace_id=$1',[workspace])).rows;expect(states.every(s=>s.effective_days>=1),JSON.stringify(states.map(s=>({days:s.effective_days,status:s.status,reason:s.reason})))).toBe(true);
  legacy=await call('PATCH','/v1/warmup/pools/'+legacy.id,{expected_version:legacy.version,action:'pause',reason:'Pausar para revisar política'});
  const a=await call('GET','/v1/numbers/'+ids[0]),preview=await call('POST','/v1/numbers/'+ids[0]+'/preparation',{action:'migration_preview',expected_version:a.version});expect(preview.new_episode_automatic_days).toBeGreaterThanOrEqual(1);
  expect(preview).toMatchObject({policy:'standard-15d/v2',manual_declarations_excluded:true,manual_checklist_required:false,remaining_automatic_days:14-preview.new_episode_automatic_days});
  const migrated=await call('POST','/v1/numbers/'+ids[0]+'/preparation',{action:'migrate',expected_version:a.version,review:preview.review});expect(migrated.episode.policy_version).toBe('standard-15d/v2');
  const preparation=await call('GET','/v1/numbers/'+ids[0]+'/preparation');expect(preparation.declarations).toEqual([]);expect(preparation.progress.manual).toBeNull();expect(preparation.progress.automatic_days).toBe(preview.new_episode_automatic_days);expect(preparation.episode.historical_evidence.previous_state.effective_days).toBe(states.find(s=>s.account_id===ids[0]).effective_days);expect((await pool.query('SELECT count(*)::int n FROM warmup_day_credits WHERE episode_id=$1',[preparation.episode.id])).rows[0].n).toBe(preview.new_episode_automatic_days);
  expect((await call('GET','/v1/numbers/'+ids[0]+'/episodes'))).toHaveLength(1);
  await call('PATCH','/v1/warmup/pools/'+legacy.id+'/profile',{expected_version:legacy.version,profile_id:profile.id,reason:'No sobrescribir la política migrada desde el editor legado'},409);
  const before=(await pool.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND attempts>0",[workspace])).rows[0].n;await processWarmup();await dispatchOutbox(100);expect((await pool.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND attempts>0",[workspace])).rows[0].n).toBe(before);
 }finally{await app.close();}
},180000);
