import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// Deliberately GET-only. This module has no external mutation interface.
export const META_GRAPH_VERSION = 'v26.0';
export const META_FRESHNESS_MS = 60 * 60 * 1000;
type Json = Record<string, any>;
export interface MetaCredential {alias: string; token: string}
export interface MetaIssue {code: string; message: string; action: string; retryable: boolean; http_status?: number; provider_code?: number; provider_subcode?: number; trace_id?: string; required_scope?: string; retry_at?: string; retry_after_seconds?: number}
export interface MetaRequestResult {path: string; credential_alias: string; portfolio_id?: string; status: 'SYNCED'|'EMPTY'|'PARTIAL'|'UNAVAILABLE'; count: number|null; issue?: MetaIssue}
export interface MetaAsset {id: string; name: string; kind: string; portfolio_id: string; credential_alias: string; source: 'META_API'; evidence_path: string; relation: string; ad_account_id?: string; campaign_id?: string; ad_set_id?: string; waba_id?: string; phone_suffix?: string; status?: string; currency?: string; page_id?: string; tracking_pixel_ids?: string[]}
export interface MetaPortfolio {id: string; name: string; credential_aliases: string[]; evidence_paths: string[]; assets: MetaAsset[]}
export interface MetaInventory {meta_profile_revisions?:Record<string,number>;source: 'META_API'; graph_api_version: string; synced_at: string; valid_until: string; status: 'SYNCED'|'PARTIAL'|'UNAVAILABLE'; credentials: {alias:string; valid:boolean|null; token_type:string|null; expires_at:string|null; data_access_expires_at:string|null; expiry_status:string; scopes:string[]; permissions_status:string; issue?:MetaIssue}[]; portfolios:MetaPortfolio[]; requests:MetaRequestResult[]; external_mutations:0}

export function readMetaCredentials(env: NodeJS.ProcessEnv = process.env): MetaCredential[] {
  const loaded:Record<string,string> = {};
  if (env.META_CREDENTIAL_ENV_FILE) {
    for (const line of readFileSync(env.META_CREDENTIAL_ENV_FILE,'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(META_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if(match) loaded[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const input = {...loaded,...env};
  const aliases = (input.META_ACCOUNT_KEYS ?? '').split(/[\s,]+/).filter(Boolean);
  const candidates = aliases.length ? aliases.map(alias=>({alias,token:input[`META_ACCOUNT_${alias.toUpperCase().replace(/[^A-Z0-9]/g,'_')}_ACCESS_TOKEN`]??''})) : [{alias:'principal',token:input.META_ACCESS_TOKEN??''}];
  const seen = new Set<string>();
  return candidates.filter(x=>{if(!x.token||seen.has(x.token))return false;seen.add(x.token);return true;});
}

export class MetaReadError extends Error {constructor(public issue:MetaIssue){super(issue.message);this.name='MetaReadError';}}
function issueFor(status:number,body:Json):MetaIssue {
  const code = Number(body.error?.code), expired = code===190, permissions = [10,200,294].includes(code), limited = status===429||[4,17,32,613,80004].includes(code), unavailable = [100,803].includes(code);
  return {code:expired?'META_TOKEN_EXPIRED':permissions?'META_PERMISSION_DENIED':limited?'META_RATE_LIMIT':unavailable?'META_RESOURCE_UNAVAILABLE':status>=500?'META_UPSTREAM_UNAVAILABLE':'META_REQUEST_REJECTED',message:expired?'La credencial Meta dejó de ser válida.':permissions?'Meta no permite consultar este recurso.':limited?'Meta limitó temporalmente las consultas.':unavailable?'El activo no existe, no está accesible o sus campos no son compatibles.':'Meta no pudo completar la consulta.',action:expired?'Renueva la credencial en el sistema seguro y sincroniza.':permissions?'Revisa los permisos y la asignación del activo al usuario de sistema.':limited?'Espera antes de volver a sincronizar.':'Revisa el activo y el permiso indicado; conserva el identificador de diagnóstico.',retryable:limited||status>=500,http_status:status,...(Number.isFinite(code)?{provider_code:code}:{}),...(Number.isFinite(body.error?.error_subcode)?{provider_subcode:body.error.error_subcode}:{}),...(typeof body.error?.fbtrace_id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(body.error.fbtrace_id)?{trace_id:body.error.fbtrace_id}:{})};
}
// Credential-local governor; the fetcher identity also isolates deterministic test transports.
export class MetaReadCoordinator {
  private cache=new Map<string,{data:Json;until:number}>();
  private pending=new Map<string,Promise<Json>>();
  private tail:Promise<unknown>=Promise.resolve();
  private cooldown:MetaIssue|undefined;
  constructor(private now=Date.now,private ttlMs=60_000){}
  async run(key:string,read:()=>Promise<Json>):Promise<Json>{
    if(this.cooldown&&Date.parse(this.cooldown.retry_at!)>this.now())throw new MetaReadError(this.cooldown);
    const cached=this.cache.get(key);if(cached&&cached.until>this.now())return structuredClone(cached.data);
    const existing=this.pending.get(key);if(existing)return structuredClone(await existing);
    const operation=this.tail.catch(()=>{}).then(async()=>{
      if(this.cooldown&&Date.parse(this.cooldown.retry_at!)>this.now())throw new MetaReadError(this.cooldown);
      try{const data=await read();if(this.cache.size>=128)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,{data:structuredClone(data),until:this.now()+this.ttlMs});return data;}
      catch(error){if(error instanceof MetaReadError&&error.issue.code==='META_RATE_LIMIT')this.cooldown=error.issue;throw error;}
    });
    this.tail=operation;this.pending.set(key,operation);
    try{return structuredClone(await operation);}finally{this.pending.delete(key);}
  }
}
const coordinators=new WeakMap<typeof fetch,Map<string,MetaReadCoordinator>>();
function coordinatorFor(token:string,fetcher:typeof fetch){
  let group=coordinators.get(fetcher);if(!group){group=new Map();coordinators.set(fetcher,group);}
  const key=createHash('sha256').update(token).digest('hex');let coordinator=group.get(key);
  if(!coordinator){if(group.size>=256)throw new MetaReadError({code:'META_READER_CAPACITY',message:'El lector Meta alcanzó su capacidad temporal.',action:'Espera antes de sincronizar.',retryable:true});coordinator=new MetaReadCoordinator();group.set(key,coordinator);}return coordinator;
}
function retryDelay(header:string|null,now=Date.now()){
  const seconds=header&&/^\d+(?:\.\d+)?$/.test(header)?Number(header):NaN;
  const date=header?Date.parse(header):NaN;
  return Math.max(60_000,Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-now:60_000);
}
export class MetaReader {
  private coordinator:MetaReadCoordinator;
  constructor(private token:string,private fetcher:typeof fetch=fetch,private pause:(ms:number)=>Promise<void>=(ms)=>new Promise(resolve=>setTimeout(resolve,ms)),private maxPages=25,coordinator?:MetaReadCoordinator){this.coordinator=coordinator??coordinatorFor(token,fetcher);}
  async get(path:string,params:Record<string,string>={}):Promise<Json> {
    if(!/^(?:me|debug_token|[A-Za-z0-9_-]+)(?:\/[a-z_]+)?$/.test(path))throw new MetaReadError({code:'META_INVALID_PATH',message:'Ruta Meta no permitida.',action:'Revisa la integración.',retryable:false});
    const url=new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`);
    for(const[key,value]of Object.entries(params))url.searchParams.set(key,value);
    const key=createHash('sha256').update(url.toString()).digest('hex');
    return this.coordinator.run(key,()=>this.request(url));
  }
  private async request(url:URL):Promise<Json>{
    for(let attempt=0;attempt<3;attempt++){
      let response:Response;
      try{response=await this.fetcher(url,{method:'GET',headers:{Authorization:`Bearer ${this.token}`},redirect:'error',signal:AbortSignal.timeout(12_000)});}catch{if(attempt<2){await this.pause(250*2**attempt);continue;}throw new MetaReadError({code:'META_TIMEOUT',message:'Meta no respondió dentro del tiempo permitido.',action:'Reintenta la sincronización; no se modificó ningún activo.',retryable:true});}
      let data:Json;
      try{data=await response.json() as Json;}catch{throw new MetaReadError({code:'META_INVALID_RESPONSE',message:'La respuesta Meta no se pudo verificar.',action:'Reintenta y conserva el identificador de diagnóstico.',retryable:true});}
      if(response.ok&&!data.error){const returnedVersion=response.headers.get('facebook-api-version');if(returnedVersion&&returnedVersion!==META_GRAPH_VERSION)throw new MetaReadError({code:'META_VERSION_MISMATCH',message:'Meta respondió con una versión distinta a la verificada.',action:'Revisa la versión del contrato antes de sincronizar.',retryable:false});return data;}
      const issue=issueFor(response.status,data);
      if(issue.code==='META_RATE_LIMIT'){const now=Date.now(),delay=retryDelay(response.headers.get('retry-after'),now);throw new MetaReadError({...issue,retry_at:new Date(now+delay).toISOString(),retry_after_seconds:Math.ceil(delay/1000)});}
      if(issue.retryable&&attempt<2){await this.pause(250*2**attempt);continue;}
      throw new MetaReadError(issue);
    }
    throw new Error('Unreachable');
  }
  async list(path:string,fields:string,params:Record<string,string>={}):Promise<{data:Json[];complete:boolean;issue?:MetaIssue}>{
    const output:Json[]=[],seen=new Set<string>();let after='';
    for(let page=0;page<this.maxPages;page++){
      let result:Json;
      try{result=await this.get(path,{...params,fields,limit:'100',...(after?{after}:{})});}catch(error){if(output.length&&error instanceof MetaReadError)return{data:output,complete:false,issue:error.issue};throw error;}
      if(!Array.isArray(result.data))throw new MetaReadError({code:'META_INVALID_RESPONSE',message:'Meta devolvió un inventario no válido.',action:'Revisa la versión del contrato.',retryable:false});
      output.push(...result.data);
      if(!result.paging?.next)return{data:output,complete:true};
      // Never follow a provider URL: only validate it and reuse its cursor on our exact path.
      let next:URL;try{next=new URL(String(result.paging.next));}catch{throw new MetaReadError({code:'META_UNSAFE_PAGINATION',message:'Paginación Meta no verificable.',action:'Revisa la integración.',retryable:false});}
      if(next.origin!=='https://graph.facebook.com'||next.pathname!==`/${META_GRAPH_VERSION}/${path}`||next.username||next.password)throw new MetaReadError({code:'META_UNSAFE_PAGINATION',message:'Meta indicó una ruta de paginación fuera del recurso.',action:'Revisa la integración.',retryable:false});
      after=String(result.paging?.cursors?.after??next.searchParams.get('after')??'');
      if(!after||seen.has(after))return{data:output,complete:false,issue:{code:'META_PAGINATION_INCOMPLETE',message:'No se pudo completar la paginación.',action:'Sincroniza de nuevo; los datos son parciales.',retryable:true}};
      seen.add(after);
    }
    return{data:output,complete:false,issue:{code:'META_PAGE_LIMIT',message:'Inventario parcial por límite de páginas.',action:'Revisa el tamaño del inventario antes de aumentar el límite operativo.',retryable:false}};
  }
  async debug(){return this.get('debug_token',{input_token:this.token});}
}
const safeText=(value:unknown,fallback:string)=>typeof value==='string'?value.replace(/EAA[A-Za-z0-9]{20,}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redactado]').replace(/\b\d[\d ()+-]{9,}\d\b/g,match=>'••••'+match.replace(/\D/g,'').slice(-4)).slice(0,240):fallback;
const opaque=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,180}$/.test(value)?value:undefined;
const dateFromSeconds=(value:unknown)=>typeof value==='number'&&value>0?new Date(value*1000).toISOString():null;
export async function discoverMeta(credentials:MetaCredential[],options:{fetcher?:typeof fetch;pause?:(ms:number)=>Promise<void>;now?:Date;maxPages?:number}={}):Promise<MetaInventory>{
  const now=options.now??new Date(),inventory:MetaInventory={source:'META_API',graph_api_version:META_GRAPH_VERSION,synced_at:now.toISOString(),valid_until:new Date(now.getTime()+META_FRESHNESS_MS).toISOString(),status:'UNAVAILABLE',credentials:[],portfolios:[],requests:[],external_mutations:0};
  const portfolios=new Map<string,MetaPortfolio>();
  const seenTokens=new Set<string>();
  for(const credential of credentials){
    if(seenTokens.has(credential.token))continue;seenTokens.add(credential.token);
    const reader=new MetaReader(credential.token,options.fetcher,options.pause,options.maxPages);
    const request=async(path:string,fields:string,required_scope:string,portfolio_id?:string)=>{try{const result=await reader.list(path,fields);inventory.requests.push({path,credential_alias:credential.alias,portfolio_id,status:result.complete?result.data.length?'SYNCED':'EMPTY':'PARTIAL',count:result.data.length,...(result.issue?{issue:{...result.issue,required_scope}}:{})});return result.data;}catch(error){const issue=error instanceof MetaReadError?error.issue:{code:'META_UNAVAILABLE',message:'No se pudo verificar Meta.',action:'Revisa la conexión segura.',retryable:false};inventory.requests.push({path,credential_alias:credential.alias,portfolio_id,status:'UNAVAILABLE',count:null,issue:{...issue,required_scope}});return[];}};
    const permissions=await request('me/permissions','permission,status','business_management');
    const info:MetaInventory['credentials'][number]={alias:credential.alias,valid:null,token_type:null,expires_at:null,data_access_expires_at:null,expiry_status:'UNAVAILABLE',scopes:permissions.filter(x=>x.status==='granted').map(x=>String(x.permission)),permissions_status:inventory.requests.at(-1)?.status??'UNAVAILABLE'};
    try{const debug=(await reader.debug()).data;info.valid=typeof debug?.is_valid==='boolean'?debug.is_valid:null;info.token_type=typeof debug?.type==='string'?debug.type:null;info.expires_at=dateFromSeconds(debug?.expires_at);info.data_access_expires_at=dateFromSeconds(debug?.data_access_expires_at);info.expiry_status=debug?.expires_at===0?'NO_SCHEDULED_EXPIRY':info.expires_at?'SCHEDULED':'UNAVAILABLE';if(Array.isArray(debug?.scopes))info.scopes=debug.scopes.filter((x:unknown)=>typeof x==='string');}catch(error){info.issue=error instanceof MetaReadError?error.issue:undefined;}
    inventory.credentials.push(info);
    const accessibleBusinesses=await request('me/businesses','id,name','business_management');
    const accounts=await request('me/adaccounts','id,name,business{id,name},account_status,currency','ads_read');
    const discovered=new Map<string,Json>();for(const row of [...accessibleBusinesses,...accounts.map(x=>x.business).filter(Boolean)])if(opaque(row.id))discovered.set(row.id,row);
    for(const[id,business]of discovered){let portfolio=portfolios.get(id);if(!portfolio){portfolio={id,name:safeText(business.name,'Portafolio sin nombre'),credential_aliases:[],evidence_paths:[],assets:[]};portfolios.set(id,portfolio);}if(!portfolio.credential_aliases.includes(credential.alias))portfolio.credential_aliases.push(credential.alias);portfolio.evidence_paths.push(accessibleBusinesses.some(x=>x.id===id)?'me/businesses':'me/adaccounts.business');
      const add=(rows:Json[],kind:string,path:string,relation:string,context:Partial<MetaAsset>={})=>{for(const row of rows){const assetId=opaque(row.id);if(!assetId)continue;const adAccountId=opaque(row.account_id);const next:MetaAsset={id:assetId,name:safeText(row.name,kind==='phone_number'?'Número de WhatsApp':'Activo sin nombre'),kind,portfolio_id:id,credential_alias:credential.alias,source:'META_API',evidence_path:path,relation,...context,...(row.status||row.effective_status||row.account_status!==undefined?{status:String(row.effective_status??row.status??row.account_status)}:{}),...(typeof row.currency==='string'?{currency:row.currency}:{}),...(adAccountId?{ad_account_id:adAccountId.startsWith('act_')?adAccountId:'act_'+adAccountId}:{}),...(opaque(row.campaign_id)?{campaign_id:row.campaign_id}:{}),...(opaque(row.adset_id)?{ad_set_id:row.adset_id}:{}),...(opaque(row.promoted_object?.page_id??row.creative?.object_story_spec?.page_id)?{page_id:row.promoted_object?.page_id??row.creative?.object_story_spec?.page_id}:{}),...(opaque(row.promoted_object?.pixel_id)?{tracking_pixel_ids:[row.promoted_object.pixel_id]}:{}),...(typeof row.display_phone_number==='string'?{phone_suffix:'••••'+row.display_phone_number.replace(/\D/g,'').slice(-4)}:{})};const previous=portfolio!.assets.find(x=>x.id===assetId&&x.kind===kind);if(!previous)portfolio!.assets.push(next);else if(previous.relation==='accessible'&&relation==='owned')Object.assign(previous,next);}};
      add(accounts.filter(x=>x.business?.id===id),'ad_account','me/adaccounts.business','owned');
      const edges:[string,string,string,string][]=[['owned_ad_accounts','ad_account','id,name,account_status,currency','business_management'],['client_ad_accounts','ad_account','id,name,account_status,currency','business_management'],['owned_pages','page','id,name','pages_show_list'],['client_pages','page','id,name','pages_show_list'],['owned_apps','app','id,name','business_management'],['client_apps','app','id,name','business_management'],['owned_whatsapp_business_accounts','waba','id,name','whatsapp_business_management'],['client_whatsapp_business_accounts','waba','id,name','whatsapp_business_management'],['ads_dataset','dataset','id,name','business_management'],['owned_pixels','pixel','id,name','ads_read'],['client_pixels','pixel','id,name','ads_read']];
      for(const[edge,kind,fields,scope]of edges){const path=`${id}/${edge}`;add(await request(path,fields,scope,id),kind,path,edge.startsWith('owned_')?'owned':edge.startsWith('client_')?'accessible':'accessible');}
      for(const asset of [...portfolio.assets].filter(x=>x.credential_alias===credential.alias)){
        if(asset.kind==='waba'){const path=`${asset.id}/phone_numbers`;add(await request(path,'id,display_phone_number,quality_rating,status','whatsapp_business_management',id),'phone_number',path,'waba_member',{waba_id:asset.id});}
        if(asset.kind==='ad_account')for(const[edge,kind,fields]of [['campaigns','campaign','id,name,status,effective_status,account_id'],['adsets','ad_set','id,name,status,effective_status,campaign_id,account_id,promoted_object'],['ads','ad','id,name,status,effective_status,campaign_id,adset_id,account_id,creative{object_story_spec}']] as const){const path=`${asset.id}/${edge}`;add(await request(path,fields,'ads_read',id),kind,path,'ad_account_member',{ad_account_id:asset.id});}
      }
    }
  }
  inventory.portfolios=[...portfolios.values()];
  inventory.status=inventory.portfolios.length?inventory.requests.some(x=>['UNAVAILABLE','PARTIAL'].includes(x.status))||inventory.credentials.some(x=>x.valid!==true)?'PARTIAL':'SYNCED':'UNAVAILABLE';
  return inventory;
}
