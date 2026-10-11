import type {Page} from '@playwright/test';
export const closureProduct={id:'product-fixture',name:'Producto de demostración',description:'Material educativo de muestra. Contenido ficticio para revisar la interfaz.',version:3,status:'PUBLISHED',environment:'REAL',knowledge:{}};
export const closureFlow={id:'flow-fixture',name:'Recorrido de demostración',version:2,status:'PUBLISHED',environment:'REAL',product_id:closureProduct.id,offer_version_id:'offer-fixture',entry_node_id:'inicio',nodes:[{id:'inicio',type:'entry',config:{},next:'mensaje'},{id:'mensaje',type:'message',config:{text:'Bienvenido al producto de muestra.'},next:'fin'},{id:'fin',type:'end',config:{}}]};
export async function closureFixture(page:Page,session:{role?:string;permissions?:string[]}={}) {
	 const requests:{path:string;environment:string|null;method:string;body:Record<string,unknown>|null;query:Record<string,string>}[]=[];
	 const role=session.role??'owner',permissions=session.permissions??['*'],assignmentsVisible=['owner','operator'].includes(role);
 const account={id:'account-fixture',name:'Número de demostración',provider:'waha',status:'STOPPED',version:2,sending_enabled:false};
 const offer={id:'offer-fixture',name:'Oferta de muestra',product_id:closureProduct.id,base_amount_minor:9700,currency:'MXN',version:2,status:'PUBLISHED'};
 const conversation={id:'conversation-fixture',version:7,contact_id:'contact-fixture',contact_name:'Contacto ficticio',account_id:account.id,account_name:account.name,stage:'QUALIFYING',status:'OPEN',last_message:'¿Qué incluye el material?',updated_at:'2026-09-07T15:00:00Z',contact:{name:'Contacto ficticio'},offer,controls:{takeover:true},messages:[{id:'message-fixture',direction:'INBOUND',text:'¿Qué incluye el material?',created_at:'2026-09-07T15:00:00Z'}],events:[],outbox:[]};
 await page.route('**/v1/**',async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname,environment=url.searchParams.get('environment'),method=req.method();
  const body=method==='GET'?null:req.postDataJSON() as Record<string,unknown>;requests.push({path,environment,method,body,query:Object.fromEntries(url.searchParams)});
  let data:unknown=[];
	  if(path==='/v1/me') data={user:{id:'fixture-user',name:'Equipo de muestra',email:'demo@example.invalid'},workspace_id:'fixture-workspace',role,permissions,environment:'SIMULATION'};
  else if(method!=='GET') {
   if(path==='/v1/simulation-snapshots') data={id:'snapshot-fixture',environment:'SIMULATION',workflow_version_id:'simulation-flow',offer_version_id:'simulation-offer',product_id:'simulation-product',account_id:'simulation-account',source:{workflow_version_id:closureFlow.id,version:2},materials:[]};
   else if(path==='/v1/simulations') data={id:'simulation-run',command_id:'simulation-command'};
   else if(path.endsWith('/evaluations')) data={id:'evaluation-fixture',version:1,state:{status:'WAITING',history:[],trace:[],virtual_seconds:0,node_id:'mensaje'},snapshot:{workflow_revision:2,seller:{sources:[]}}};
	  else if(path.endsWith('/configuration'))data={configuration_published:true,product:closureProduct,offer,workflow:closureFlow,seller:{id:'agent-fixture',name:'Agente de demostración',status:'PUBLISHED'},materials:[{id:'asset-fixture',name:'Guía de muestra',status:'READY'}],checks:{product:true,offer:true,workflow:true,seller:true,materials:true},simulation:{status:'COMPLETED',observed_at:'2026-09-22T14:00:00.000Z',source:'records.simulation+canonical_flow_proof',environment:'SIMULATION',external_effects:false,verification:'SIMULATION_COMPLETED_CURRENT'},visibility:{assignments:assignmentsVisible},accounts:assignmentsVisible?[{id:account.id,name:account.name,uses_product:true,authorization_registered:true}]:[],connections:{assigned_accounts:assignmentsVisible?1:null,sales_ai:{configured:false,state:'PROVIDER_PENDING',model:null}},operation:{authorized:false,scope:'CONFIGURATION_ONLY'}};
  else if(path==='/v1/products') data={...closureProduct,...body};
   else {await route.fulfill({status:400,json:{error:{code:'FIXTURE_MUTATION_DENIED',message:'Esta acción no está incluida en la demostración.'}}});return;}
	  } else if(path.endsWith('/configuration'))data={configuration_published:true,product:closureProduct,offer,workflow:closureFlow,seller:{id:'agent-fixture',name:'Agente de demostración',status:'PUBLISHED'},materials:[{id:'asset-fixture',name:'Guía de muestra',status:'READY'}],checks:{product:true,offer:true,workflow:true,seller:true,materials:true},simulation:{status:'COMPLETED',observed_at:'2026-09-22T14:00:00.000Z',source:'records.simulation+canonical_flow_proof',environment:'SIMULATION',external_effects:false,verification:'SIMULATION_COMPLETED_CURRENT'},visibility:{assignments:assignmentsVisible},accounts:assignmentsVisible?[{id:account.id,name:account.name,uses_product:true,authorization_registered:true}]:[],connections:{assigned_accounts:assignmentsVisible?1:null,sales_ai:{configured:false,state:'PROVIDER_PENDING',model:null}},operation:{authorized:false,scope:'CONFIGURATION_ONLY'}};
  else if(path==='/v1/products') data=[closureProduct];
  else if(path===`/v1/products/${closureProduct.id}`)data=closureProduct;
  else if(path===`/v1/products/${closureProduct.id}/assistant`)data={product:closureProduct,resources:[],assignments:[],coverage:{limit:200,complete:true},next_actions:['Configurar y publicar vendedor','Consultar inventario y seleccionar destinos'],proposals:[],provider_called:false,external_effects:false};
  else if(path==='/v1/costs')data={totals:[],coverage:{unknown_operations:0}};
  else if(path==='/v1/offers'||path.startsWith('/v1/products/')&&path.endsWith('/offers'))data=[environment==='SIMULATION'?{...offer,id:'simulation-offer'}:offer];
  else if(path==='/v1/assets')data=[{id:'asset-fixture',name:'Guía de muestra',type:'document',mime_type:'application/pdf',status:'READY',version:1}];
  else if(path==='/v1/workflows')data=environment==='SIMULATION'?[{...closureFlow,id:'simulation-flow',environment:'SIMULATION',offer_version_id:'simulation-offer'}]:[closureFlow];
  else if(path===`/v1/workflows/${closureFlow.id}`||path==='/v1/workflows/simulation-flow')data={...closureFlow,id:path.endsWith('simulation-flow')?'simulation-flow':closureFlow.id};
  else if(path.endsWith('/seller'))data={sources:[],offer,product:closureProduct};
  else if(path==='/v1/channel-accounts')data=environment==='SIMULATION'?[{...account,id:'simulation-account',provider:'simulator'}]:[account];
  else if(path.endsWith('/setup'))data={account_version:2,configuration_version:1,sending_enabled:false,options:{products:[closureProduct],offers:[offer],workflows:[closureFlow],agents:[],gateways:[]},effective_assignment:{},checks:[],ready:false,blockers:['Vincula el número para comprobar su identidad'],authorization:null};
  else if(path==='/v1/conversations')data=environment==='SIMULATION'?[]:[conversation];
  else if(path===`/v1/conversations/${conversation.id}`)data=conversation;
  else if(path==='/v1/contacts')data=[conversation.contact];
  else if(path==='/v1/reports/summary'){
   const group=url.searchParams.get('group_by')??'offer_version_id',segments={offer_version_id:{id:'offer-fixture',key:'offer-fixture',label:'Oferta de muestra'},account_id:{id:'account-fixture',key:'account-fixture',label:'Número de demostración'},agent_version_id:{id:'agent-fixture',key:'agent-fixture',label:'Agente de demostración'},source_type:{id:'ad',key:'ad',label:'Anuncio'}}[group as 'offer_version_id'];
   data={group_by:group,segments:[{...segments,group_by:group,conversations:1,sample_size:1,orders:0,reconciled:0,revenue_by_currency:[],attribution:{observed:1,inferred:0,unknown:0,evidence_coverage:1}}],cohort:{basis:'conversation.started_at',size:1,from:'2026-09-01T00:00:00.000Z',to_exclusive:'2026-10-01T00:00:00.000Z'},counts:{conversations:1,orders:0,sales:0,receipt_approved:0,reconciled:0},revenue_state:'ZERO',revenue_minor:0,currency:null,revenue_by_currency:[],attribution:{observed:1,inferred:0,unknown:0,evidence_coverage:1},funnel:[{stage:'NEW',count:1}],measured_at:'2026-09-22T15:00:00.000Z',definitions:{revenue:'Comprobantes aprobados.',attribution:'Origen observado, inferido o desconocido.'}};
  }
  else if(path==='/v1/reports/export')data=[{group_by:url.searchParams.get('group_by')??'offer_version_id',key:'fixture',label:'Corte visible',conversations:1,orders:0,reconciled:0}];
  else if(path==='/v1/warmup')data={installed:true,enabled:false,pool:null,accounts:[],plans:[],jobs:[],provider_verified:false};
  else if(path==='/v1/settings/operations')data={version:1,body:{dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false,allow_channel_onboarding:false,contact_messages_per_minute:1,channel_account_concurrency:1}};
  else if(path==='/v1/settings/launch')data={configuration_version:1,release_hold:false,policy_open:false,workspace_paused:false,observed_at:new Date().toISOString(),summary:{operating:0,attention:0,blocked:0},numbers:[]};
  else if(path==='/v1/settings/integrations')data={definitions:[],profiles:[]};
  else if(path==='/v1/identity/mail')data={version:0,enabled:false,credentials_configured:false};
  else if(path==='/v1/reports/campaign-performance')data={summary:{spend_minor:null,revenue_minor:0,sales:0,attributed_sales:0,attributed_revenue_minor:0,cpa_minor:null,roas:null,balance_minor:null,average_ticket_minor:null,cost_per_meta_conversation_minor:null,conversations:null,impressions:null,clicks:null},series:[],groups:{products:[],campaigns:[],ads:[]},quality:{status:'UNAVAILABLE',source:'NONE',available:false,complete:false,tax_missing:false,excluded_accounts:[],accounts:[],controls:[],unattributed:{sales:0,revenue_minor:0},spend_control:{differences:0,difference_minor:0,unassigned_spend_minor:0},coverage_sales:null,coverage_revenue:null},options:{products:[],campaigns:[],accounts:[]},measured_at:'2026-09-07T15:00:00Z',revision:'fixture'};
  else if(path==='/v1/system/status')data={controls:[],services:[],queue:{},operation:{}};
  else if(path==='/v1/commands/simulation-command')data={id:'simulation-command',status:'PENDING'};
  else if(path==='/v1/meta/status')data={status:'NOT_CONFIGURED',configured:false,portfolios:[],accounts:[],connections:[]};
  await route.fulfill({json:{data,meta:{total:Array.isArray(data)?data.length:1}}});
 });
 await page.route('**/api/auth/**',route=>route.fulfill({status:401,json:{error:{code:'FIXTURE_ONLY',message:'Sesión de muestra'}}}));
 return requests;
}
