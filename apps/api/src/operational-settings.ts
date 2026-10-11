import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {operationalSettingsPatchSchema,operationalSettingsSchema} from '@commerce/contracts';
import {pool,readOperationalSettings,writeOperationalSettings} from '@commerce/db';
import {principal,envOf,parseBody,mutate,fail,audit} from './context.js';
import {listNumberPage} from './number-list.js';
const requestSchema=operationalSettingsPatchSchema.extend({environment:z.enum(['REAL','SIMULATION']).optional()});

export async function operationalSettingsRoutes(app:FastifyInstance){
  const owner=(req:Parameters<typeof principal>[0])=>{const p=principal(req);if(p.service||p.role!=='owner')throw fail(403,'FORBIDDEN');return p;};
  async function launchStatus(req:Parameters<typeof principal>[0]){
    const p=owner(req);if(envOf(req)!=='REAL')throw fail(400,'REAL_REQUIRED');
    const policy=await readOperationalSettings(pool,p.workspace_id,'REAL');
    const paused=Boolean((await pool.query("SELECT 1 FROM manual_controls WHERE workspace_id=$1 AND scope_type='workspace' AND scope_id=$1 AND (paused OR suppressed)",[p.workspace_id])).rowCount);
    const page=await listNumberPage(pool,p,'REAL',{offset:0,limit:100});
    const ids=page.data.map(number=>number.id);
    const grants=ids.length?(await pool.query("SELECT a.account_id::text account_id,a.id::text assignment_id,auth.expires_at,auth.scope->>'recipient_mode' recipient_mode,auth.scope->>'max_messages' max_messages,auth.scope->>'allow_automation' allow_automation FROM commercial_assignments a JOIN operation_authorizations auth ON auth.id=a.authorization_id WHERE a.workspace_id=$1 AND a.environment='REAL' AND a.state='ACTIVE' AND a.account_id::text=ANY($2::text[]) AND auth.revoked_at IS NULL AND auth.configuration_version=$3",[p.workspace_id,ids,policy.version])).rows:[];
    const grantsById=new Map<string,typeof grants>();for(const row of grants)grantsById.set(String(row.account_id),[...(grantsById.get(String(row.account_id))??[]),row]);
    const effects=ids.length?(await pool.query("SELECT account_id,count(*) FILTER(WHERE status='UNKNOWN')::int unknown,count(*) FILTER(WHERE status='BLOCKED')::int blocked FROM outbox WHERE workspace_id=$1 AND environment='REAL' AND account_id=ANY($2::text[]) GROUP BY account_id",[p.workspace_id,ids])).rows:[];
    const effectsById=new Map(effects.map(row=>[String(row.account_id),row]));
    const policyOpen=!policy.body.dispatch_frozen&&policy.body.real_sends_enabled&&policy.body.allow_real_operations;
    const numbers=page.data.map(number=>{
      const effect=effectsById.get(number.id),unknown=Number(effect?.unknown??0),blocked=Number(effect?.blocked??0),accountGrants=grantsById.get(number.id)??[],expired=accountGrants.some(row=>new Date(row.expires_at).getTime()<=Date.now()),scopes=accountGrants.filter(row=>new Date(row.expires_at).getTime()>Date.now()).map(row=>({assignment_id:row.assignment_id,recipient_mode:row.recipient_mode,max_messages:Number(row.max_messages),allow_automation:row.allow_automation==='true',expires_at:row.expires_at})),expires=scopes.length?scopes.reduce((earliest,scope)=>Date.parse(scope.expires_at)<Date.parse(earliest)?scope.expires_at:earliest,scopes[0]!.expires_at):null;
      const ready=policyOpen&&!paused&&number.primary_state==='READY_TO_SELL'&&number.sales_readiness.some(s=>s.ready);
      const code=policy.release_hold?'RELEASE_HOLD':!policyOpen?'REAL_POLICY_FROZEN':paused?'WORKSPACE_PAUSED':unknown?'UNCERTAIN_EFFECT':ready?'OPERATING':blocked?'BLOCKED_EFFECTS':expired?'AUTHORIZATION_EXPIRED':number.reason_code==='CONNECTED'?'NO_READY_ASSIGNMENT':number.reason_code;
      const status=ready&&!unknown?'OPERANDO':unknown||number.primary_state==='ATTENTION'||(!ready&&blocked>0)?'BLOQUEADO':'NECESITA_ATENCION';
      return{id:number.id,alias:number.alias,status,reason_code:code,primary_state:number.primary_state,next_action:number.next_action,authorization_expires_at:expires,authorization_scopes:scopes,authorization_expiring_soon:!!expires&&Date.parse(expires)<Date.now()+24*3600000,unknown_effects:unknown,blocked_effects:blocked,sales_readiness:number.sales_readiness};
    });
    return{environment:'REAL',configuration_version:policy.version,release_hold:policy.release_hold,release_hold_at:policy.release_hold_at,policy_open:policyOpen,workspace_paused:paused,numbers,summary:{operating:numbers.filter(n=>n.status==='OPERANDO').length,attention:numbers.filter(n=>n.status==='NECESITA_ATENCION').length,blocked:numbers.filter(n=>n.status==='BLOQUEADO').length},observed_at:new Date().toISOString()};
  }
  app.get('/v1/settings/launch',{schema:{tags:['Settings'],summary:'Owner launch status and alerts per REAL number'}},async req=>({data:await launchStatus(req)}));
  app.post('/v1/settings/launch/switch',{schema:{tags:['Settings'],summary:'Owner pause or open REAL without replacing valid grants on resume'}},async req=>{
    const p=owner(req);if(envOf(req)!=='REAL')throw fail(400,'REAL_REQUIRED');
    const input=z.object({expected_version:z.number().int().min(0),action:z.enum(['OPEN','PAUSE']),reason:z.string().trim().min(3).max(2000),confirmation:z.literal('CONFIRM_REAL_SWITCH')}).strict().parse(parseBody(req));
    const result=await mutate(req,'operations.launch_switch',async c=>{
      const current=await readOperationalSettings(c,p.workspace_id,'REAL',{lock:'update'});
      if(current.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
      if(current.release_hold&&input.action==='OPEN')throw fail(409,'RELEASE_HOLD_ACTIVE');
      let next=current;
      if(input.action==='OPEN'&&(current.body.dispatch_frozen||!current.body.real_sends_enabled||!current.body.allow_real_operations))next=await writeOperationalSettings(c,p.workspace_id,'REAL',current.version,{...current.body,dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true},p.user.id);
      await c.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'workspace',$1,$2,$3,$4) ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=EXCLUDED.paused,reason=EXCLUDED.reason,actor_id=EXCLUDED.actor_id,version=manual_controls.version+1,updated_at=now()",[p.workspace_id,input.action==='PAUSE',input.reason,p.user.id]);
      await audit(c,req,input.action==='PAUSE'?'operations.launch_paused':'operations.launch_opened',p.workspace_id,{reason:input.reason,previous_version:current.version,configuration_version:next.version,authorization_renewed:false});
      return{data:{action:input.action,configuration_version:next.version,authorization_renewed:false}};
    });return{data:{...result.data,readback:await launchStatus(req)}};
  });
  app.get('/v1/settings/operations',{schema:{tags:['Settings'],summary:'Read current operational policy (human owner only)'}},async req=>{
    const p=owner(req);return{data:await readOperationalSettings(pool,p.workspace_id,envOf(req))};
  });
  app.patch('/v1/settings/operations',{
    // Strict Zod validation preserves rejection of unknown fields instead of AJV silently removing them.
    validatorCompiler:()=>data=>{const parsed=requestSchema.safeParse(data);return parsed.success?{value:parsed.data}:{error:new Error('INVALID_OPERATIONAL_SETTINGS')};},
    schema:{tags:['Settings'],summary:'Update operational policy and invalidate earlier authorizations',body:z.toJSONSchema(requestSchema,{target:'draft-7'})},
  },async req=>{
    const p=owner(req),body=operationalSettingsPatchSchema.parse(parseBody(req));
    const result=await mutate(req,'operations.update',async client=>{
      const environment=envOf(req),current=await readOperationalSettings(client,p.workspace_id,environment,{lock:'update'});
      const next=await writeOperationalSettings(client,p.workspace_id,environment,body.expected_version,operationalSettingsSchema.parse({...current.body,...body.changes}),p.user.id);
      await audit(client,req,'operational_settings.updated',p.workspace_id,{reason:body.reason,previous_version:current.version,configuration_version:next.version,changes:body.changes},environment);
      return{data:next};
    });return{data:result.data};
  });
}
