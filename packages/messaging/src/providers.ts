import {parseGroup} from './groups.js';
import { ProviderError, type MessagingProvider, type ProviderCapabilities, type OutboundMessage, type SendResult, type HealthSignal, type Fetch } from './types.js';
import {createHash} from 'node:crypto';
import { guardedUrl, jsonRequest, limitedBytes } from './security.js';
import {webhookConfiguration, reconcileWebhook} from './waha-webhook.js';
const caps = (provider: 'simulator' | 'waha' | 'cloud'): ProviderCapabilities => ({ provider, experimental: provider === 'waha', qr: provider === 'waha', sessionLifecycle: provider !== 'cloud', formats: provider === 'cloud' ? ['text','image','audio','document','template'] : ['text','image','audio','document'], acknowledgements: true, nativeFencing: false, remoteIdempotency: false, groups:provider==='cloud'?'unsupported':provider==='simulator'?'supported':'probe_required', accountQuality: provider === 'cloud', businessWindow: provider === 'cloud' });
const signal = (dimension: HealthSignal['dimension'], status: HealthSignal['status'], value: unknown, availability: HealthSignal['availability'] = 'supported'): HealthSignal => ({ dimension, status, value, availability, scope: 'account', source: 'provider_read', observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
const sessionStatus=(value:unknown)=>typeof value==='string'&&['STOPPED','STARTING','SCAN_QR_CODE','WORKING','FAILED','PASSKEY_REQUIRED','PASSKEY_CONFIRMATION_REQUIRED'].includes(value)?value:'UNKNOWN';
const cappingStatuses=new Set(['NONE','FIRST_WARNING','SECOND_WARNING','CAPPED']);
function wahaRestrictionSignal(timelock:PromiseSettledResult<any>,capping:PromiseSettledResult<any>,session?:any):HealthSignal {
  const explicitTimelock=timelock.status==='fulfilled'&&typeof timelock.value?.isActive==='boolean'?timelock.value:undefined;
  const explicitCapping=capping.status==='fulfilled'&&typeof capping.value?.cappingStatus==='string'&&cappingStatuses.has(capping.value.cappingStatus)?capping.value:undefined;
  const cachedTimelock=session?.me?.reachoutTimelock??session?.data?.reachoutTimelock;
  const cachedCapping=session?.me?.messageCapping??session?.data?.messageCapping;
  const value={reachout_timelock:explicitTimelock??cachedTimelock??null,message_capping:explicitCapping??cachedCapping??null,latest_read:{timelock:!!explicitTimelock,capping:!!explicitCapping}};
  if(explicitTimelock?.isActive===true||explicitCapping?.cappingStatus==='CAPPED')return signal('restriction','BLOCKED',value);
  if(explicitTimelock&&explicitCapping)return signal('restriction','OK',value);
  if((!explicitTimelock&&cachedTimelock?.isActive===true)||(!explicitCapping&&cachedCapping?.cappingStatus==='CAPPED'))return signal('restriction','BLOCKED',value);
  return signal('restriction','UNKNOWN',value);
}
function result(error: unknown): SendResult { return error instanceof ProviderError && error.httpStatus && error.httpStatus >= 400 && error.httpStatus < 500 && ![408,429].includes(error.httpStatus) ? {status:'REJECTED',reason:error.code} : {status:'UNKNOWN',reason:error instanceof ProviderError ? error.code : 'REMOTE_ACCEPTANCE_UNCERTAIN'}; }
export class SimulatorProvider implements MessagingProvider {
  readonly capabilities = caps('simulator');
  readonly sent: OutboundMessage[] = [];
  constructor(private state: 'WORKING' | 'FAILED' | 'AMBIGUOUS' = 'WORKING', private delivered?: (message:OutboundMessage,providerId:string)=>Promise<void>) {}
  async send(message: OutboundMessage): Promise<SendResult> { if (this.state === 'FAILED') return {status:'REJECTED',reason:'SIMULATED_ACCOUNT_FAILURE'}; this.sent.push(structuredClone(message)); await this.delivered?.(message,`sim:${message.effectId}`); return this.state === 'AMBIGUOUS' ? {status:'UNKNOWN',reason:'SIMULATED_ACCEPTED_WITH_LOST_RESPONSE'} : {status:'ACCEPTED',providerMessageId:`sim:${message.effectId}`}; }
  async health(): Promise<HealthSignal[]> { return [{...signal('session',this.state === 'FAILED' ? 'BLOCKED' : 'OK',this.state),source:'local_probe'},signal('quality','UNKNOWN',null,'not_available')]; }
  async lifecycle(action: 'start'|'stop'|'restart'|'logout') { this.state = action === 'stop' || action === 'logout' ? 'FAILED' : 'WORKING'; return {status:this.state}; }
  async qr(): Promise<{mimeType:string;data:string;expiresAt:string}> { throw new ProviderError('QR_NOT_SUPPORTED'); }
  async media(reference:{providerId?:string}): Promise<{bytes:Uint8Array;mimeType:string}> {if(reference.providerId==='fixture:pdf')return{bytes:Buffer.from('%PDF-1.4\n% Commerce OS local fixture only\n%%EOF'),mimeType:'application/pdf'};if(reference.providerId==='fixture:png')return{bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=','base64'),mimeType:'image/png'};throw new ProviderError('SIMULATOR_MEDIA_REQUIRES_EXPLICIT_FIXTURE'); }
}
export interface WahaConfig { baseUrl:string; apiKey:string; session:string; engine:'GOWS'|'NOWEB'|'WEBJS'; timeoutMs?:number; webhook?:{url:string;hmacKey:string} }
export class WahaProvider implements MessagingProvider {
  readonly capabilities = caps('waha');
  constructor(private config: WahaConfig, private fetcher: Fetch = fetch) { const u = new URL(config.baseUrl); if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new ProviderError('GATEWAY_URL_INVALID'); }
  private request(path:string,method='GET',body?:unknown,accept='application/json',timeoutMs=this.config.timeoutMs??15_000) { return jsonRequest(this.fetcher,new URL(path,this.config.baseUrl),{method,headers:{'X-Api-Key':this.config.apiKey,'Content-Type':'application/json',Accept:accept},...(body === undefined ? {} : {body:JSON.stringify(body)})},timeoutMs); }
  async send(message:OutboundMessage):Promise<SendResult> {
    if (!this.capabilities.formats.includes(message.kind)) return {status:'REJECTED',reason:'FORMAT_UNSUPPORTED'};
    const chatId = message.recipient.startsWith('wa:') ? `${message.recipient.slice(3)}@c.us` : message.recipient.startsWith('lid:') ? `${message.recipient.slice(4)}@lid` : message.recipient.replace(/^opaque:/,'');
    const body:Record<string,unknown> = {session:this.config.session,chatId};
    let endpoint='/api/sendText';
    if (message.kind === 'text') { body.text=message.text ?? ''; body.linkPreview=false; }
    else { if (!message.media) return {status:'REJECTED',reason:'MEDIA_REQUIRED'}; endpoint=message.kind === 'image' ? '/api/sendImage' : message.kind === 'audio' ? '/api/sendVoice' : '/api/sendFile'; body.caption=message.text; if(message.kind==='audio')body.convert=true; body.file={mimetype:message.media.mimeType,filename:message.media.filename,...(message.media.bytes ? {data:Buffer.from(message.media.bytes).toString('base64')} : {url:message.media.url})}; }
    // Voice conversion can outlive the default request timeout even when WAHA
    // has accepted the message. Preserve UNKNOWN on a real timeout, but allow
    // enough time to capture WAHA's message ID in the normal case.
    const sendTimeoutMs=this.config.timeoutMs??(message.kind==='audio'?45_000:15_000);
    try { const response=await this.request(endpoint,'POST',body,'application/json',sendTimeoutMs); const id=typeof response.id === 'string' ? response.id : response.id?._serialized; if (!id) return {status:'UNKNOWN',reason:'PROVIDER_RESPONSE_WITHOUT_MESSAGE_ID'}; return {status:'ACCEPTED',providerMessageId:String(id)}; } catch(error) { return result(error); }
  }
  async runtime(){
    const value=await this.request('/api/server/version','GET',undefined,'application/json',5000);
    if(typeof value.version!=='string'||typeof value.engine!=='string'||value.engine!==this.config.engine)throw new ProviderError('PROVIDER_RUNTIME_UNVERIFIED');
    return{version:value.version,engine:value.engine};
  }
  async listGroups(input:{offset:number;limit:number}){
    if(!Number.isInteger(input.offset)||input.offset<0||!Number.isInteger(input.limit)||input.limit<1||input.limit>100)throw new ProviderError('GROUP_PAGINATION_INVALID');
    const value=await this.request(`/api/${encodeURIComponent(this.config.session)}/groups?offset=${input.offset}&limit=${input.limit}`);
    const rows=Array.isArray(value)?value:Object.values(value);
    if(rows.length>input.limit||rows.some((g:any)=>typeof g?.id!=='string'||!/^[\d-]+@g\.us$/.test(g.id)))throw new ProviderError('GROUP_LIST_RESPONSE_UNSUPPORTED');
    return{groups:rows.map((g:any)=>({id:g.id,name:String(g.subject??g.name??'Grupo propio').slice(0,100)})),hasMore:rows.length===input.limit};
  }
  async group(id:string){
    if(!/^[\d-]+@g\.us$/.test(id))throw new ProviderError('GROUP_ID_INVALID');
    const path=`/api/${encodeURIComponent(this.config.session)}/groups/${encodeURIComponent(id)}`;
    const [detail,members,security,runtime]=await Promise.all([this.request(path,'GET',undefined,'application/json',5000),this.request(path+'/participants/v2','GET',undefined,'application/json',5000),this.request(path+'/settings/security/messages-admin-only','GET',undefined,'application/json',5000),this.runtime()]);
    return parseGroup(id,detail,members,security,runtime);
  }
  async profile():Promise<{identity:string;name:string}>{
    const value=await this.request(`/api/${encodeURIComponent(this.config.session)}/profile`);
    if(typeof value.id!=='string'||typeof value.name!=='string')throw new ProviderError('PROFILE_RESPONSE_INVALID');
    return{identity:value.id,name:value.name};
  }
  async updateProfile(input:{name:string;about:string;picture?:{bytes:Uint8Array;mimeType:string}},beforeMutation?:()=>Promise<void>):Promise<void>{
    const path=`/api/${encodeURIComponent(this.config.session)}/profile`;
    for(const [suffix,body]of [['name',{name:input.name}],['status',{status:input.about}]]as const){
      await beforeMutation?.();const value=await this.request(`${path}/${suffix}`,'PUT',body);if(value.success!==true)throw new ProviderError('PROFILE_UPDATE_UNCONFIRMED');
    }
    if(input.picture){await beforeMutation?.();const value=await this.request(`${path}/picture`,'PUT',{file:{data:Buffer.from(input.picture.bytes).toString('base64'),mimetype:input.picture.mimeType}});if(value.success!==true)throw new ProviderError('PROFILE_PICTURE_UNCONFIRMED');}
  }
  async health():Promise<HealthSignal[]> {
    const sessionName=encodeURIComponent(this.config.session),[sessionRead,timelockRead,cappingRead]=await Promise.allSettled([
      this.request(`/api/sessions/${sessionName}`,'GET',undefined,'application/json',5000),
      this.request(`/api/sessions/${sessionName}/timelock`,'GET',undefined,'application/json',5000),
      this.request(`/api/sessions/${sessionName}/capping`,'GET',undefined,'application/json',5000)
    ]);
    const session=sessionRead.status==='fulfilled'?sessionRead.value:undefined,s:HealthSignal[]=[];
    if(sessionRead.status==='fulfilled'){const current=sessionRead.value,status=sessionStatus(current.status),identity=typeof current.me?.id==='string'?current.me.id:'';s.push(signal('session',status==='WORKING'&&!!identity?'OK':'BLOCKED',status),signal('quality','UNKNOWN',null,'not_available'));
      if(status==='WORKING')s.push(signal('transport',identity?'OK':'UNKNOWN',identity?{identity_verified:true,identity_fingerprint:createHash('sha256').update(identity).digest('hex')}:'CONNECTED_IDENTITY_UNAVAILABLE'));
      if(this.config.webhook){const webhook=webhookConfiguration(current.config,this.config.webhook);s.push(signal('infrastructure',webhook.matches?'OK':'BLOCKED',{kind:'webhook',...webhook}));}
    }else{s.push(signal('session','UNKNOWN',sessionRead.reason instanceof ProviderError?sessionRead.reason.code:'GATEWAY_UNREACHABLE'));}
    s.push(wahaRestrictionSignal(timelockRead,cappingRead,session));
    return s;
  }
  async lifecycle(action:'start'|'stop'|'restart'|'logout') {
    const session=encodeURIComponent(this.config.session),path=`/api/sessions/${session}`;
    if(action==='start'||action==='restart'){
      let existing;
      try{existing=await this.request(path);}catch(error){
        if(action!=='start'||!(error instanceof ProviderError)||error.httpStatus!==404)throw error;
        await this.request('/api/sessions','POST',{name:this.config.session,start:false,config:this.config.webhook?reconcileWebhook({},this.config.webhook):{webhooks:[]}});
      }
      if(existing&&this.config.webhook&&!webhookConfiguration(existing.config,this.config.webhook).matches){
        // WAHA restarts active sessions on PUT; do not issue a second restart or logout.
        await this.request(path,'PUT',{name:this.config.session,config:reconcileWebhook(existing.config,this.config.webhook)});
        const updated=await this.request(path);
        if(!webhookConfiguration(updated.config,this.config.webhook).matches)throw new ProviderError('WEBHOOK_UPDATE_UNCONFIRMED');
        if(existing.status!=='STOPPED')return{status:sessionStatus(updated.status)};
      }else if(existing&&action==='start'&&['STARTING','SCAN_QR_CODE','WORKING'].includes(existing.status))return{status:sessionStatus(existing.status)};
    }
    const response=await this.request(`${path}/${action}`,'POST');
    return{status:sessionStatus(response.status??(action==='stop'||action==='logout'?'STOPPED':'STARTING'))};
  }
  async recentInbound(input:{since:string;until:string;limit:number}){
    if(!['GOWS','NOWEB'].includes(this.config.engine))throw new ProviderError('HISTORY_ENGINE_UNSUPPORTED');
    const from=Math.ceil(Date.parse(input.since)/1000),until=Math.floor(Date.parse(input.until)/1000);
    if(!Number.isFinite(from)||!Number.isFinite(until)||until<from||until-from>86400||!Number.isInteger(input.limit)||input.limit<1||input.limit>100)throw new ProviderError('HISTORY_WINDOW_INVALID');
    const params=new URLSearchParams({limit:String(input.limit+1),offset:'0',downloadMedia:'false','filter.timestamp.gte':String(from),'filter.timestamp.lte':String(until),'filter.fromMe':'false'});
    const rows=await this.request(`/api/${encodeURIComponent(this.config.session)}/chats/all/messages?${params}`);
    if(!Array.isArray(rows)||rows.length>input.limit+1)throw new ProviderError('HISTORY_RESPONSE_INVALID');
    const messages:Record<string,unknown>[]=[];
    for(const m of rows.slice(0,input.limit)){
      if(!m||typeof m.id!=='string'||m.id.length>256||typeof m.from!=='string'||m.from.length>128||m.fromMe!==false||!Number.isFinite(m.timestamp)||m.timestamp<from||m.timestamp>until)throw new ProviderError('HISTORY_RESPONSE_OUT_OF_SCOPE');
      if(!/@(c\.us|s\.whatsapp\.net|lid)$/.test(m.from))continue;
      messages.push({id:m.id,from:m.from,fromMe:false,timestamp:m.timestamp,body:typeof m.body==='string'?m.body.slice(0,4096):'',hasMedia:m.hasMedia===true,...(typeof m.fromAlt==='string'&&m.fromAlt.length<=128&&/@(c\.us|s\.whatsapp\.net|lid)$/.test(m.fromAlt)?{fromAlt:m.fromAlt}:{}),...(m.media&&typeof m.media==='object'?{media:{mimetype:typeof m.media.mimetype==='string'?m.media.mimetype.slice(0,128):'',filename:typeof m.media.filename==='string'?m.media.filename.slice(0,256):undefined}}:{})});
    }
    return{messages:messages.sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)),truncated:rows.length>input.limit};
  }
  async qr() { const session=await this.request(`/api/sessions/${encodeURIComponent(this.config.session)}`);if(session.status==='WORKING')throw new ProviderError('SESSION_ALREADY_CONNECTED');if(session.status!=='SCAN_QR_CODE')throw new ProviderError('QR_NOT_READY');const response=await this.request(`/api/${encodeURIComponent(this.config.session)}/auth/qr?format=image`); if(typeof response.data!=='string'||response.data.length>2_000_000||!/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(response.data)||response.mimetype!=='image/png') throw new ProviderError('QR_RESPONSE_INVALID'); return {mimeType:'image/png',data:response.data,expiresAt:new Date(Date.now()+15_000).toISOString()}; }
  async media(reference:{url?:string}) { if(!reference.url) throw new ProviderError('MEDIA_REFERENCE_REQUIRED'); const url=guardedUrl(reference.url,this.config.baseUrl); const response=await this.fetcher(url,{headers:{'X-Api-Key':this.config.apiKey},redirect:'error',signal:AbortSignal.timeout(this.config.timeoutMs ?? 15_000)}); return {bytes:await limitedBytes(response),mimeType:response.headers.get('content-type') ?? 'application/octet-stream'}; }
}
export interface CloudConfig { token:string; phoneNumberId:string; graphVersion:string; timeoutMs?:number; baseUrl?:string }
export class CloudProvider implements MessagingProvider {
  readonly capabilities=caps('cloud');
  private origin:string;
  constructor(private config:CloudConfig,private fetcher:Fetch=fetch) { if(!/^v\d+\.0$/.test(config.graphVersion)||!/^\d+$/.test(config.phoneNumberId)) throw new ProviderError('CLOUD_CONFIGURATION_INVALID'); this.origin=config.baseUrl ?? 'https://graph.facebook.com'; }
  private request(path:string,method='GET',body?:unknown) { return jsonRequest(this.fetcher,`${this.origin}/${this.config.graphVersion}/${path}`,{method,headers:{Authorization:`Bearer ${this.config.token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},this.config.timeoutMs??15_000); }
  async send(message:OutboundMessage):Promise<SendResult> {
    const to=message.recipient.replace(/^wa:/,''); if(!/^\d{6,18}$/.test(to)) return {status:'REJECTED',reason:'CLOUD_REQUIRES_CONFIRMED_PHONE_IDENTITY'};
    const body:Record<string,unknown>={messaging_product:'whatsapp',recipient_type:'individual',to,type:message.kind,biz_opaque_callback_data:message.effectId};
    if(message.kind==='text') body.text={body:message.text,preview_url:false};
    else if(message.kind==='template') {
      if(!message.template?.approved)return{status:'REJECTED',reason:'APPROVED_TEMPLATE_REQUIRED'};
      const components=structuredClone(message.template.components??[]) as Record<string,unknown>[];
      if(message.media){
        if(message.media.mimeType!=='video/mp4'||components.some(component=>String(component?.type??'').toLowerCase()==='header'))return{status:'REJECTED',reason:'TEMPLATE_MEDIA_UNSUPPORTED'};
        let providerId=message.media.providerId;
        if(!providerId&&message.media.bytes){try{providerId=await this.upload(message.media.bytes,message.media.mimeType,message.media.filename??'template-header.mp4');}catch(error){return{status:'REJECTED',reason:error instanceof ProviderError?error.code:'MEDIA_UPLOAD_FAILED'};}}
        if(!providerId&&!message.media.url)return{status:'REJECTED',reason:'MEDIA_REFERENCE_REQUIRED'};
        components.unshift({type:'header',parameters:[{type:'video',video:providerId?{id:providerId}:{link:message.media.url}}]});
      }
      body.template={name:message.template.name,language:{code:message.template.language},components};
    }
    else { if(!message.media) return {status:'REJECTED',reason:'MEDIA_REQUIRED'}; let providerId=message.media.providerId;
      if(!providerId && message.media.bytes) { try { providerId=await this.upload(message.media.bytes,message.media.mimeType,message.media.filename ?? 'asset'); } catch(error) { return {status:'REJECTED',reason:error instanceof ProviderError ? error.code : 'MEDIA_UPLOAD_FAILED'}; } }
      if(!providerId&&!message.media.url) return {status:'REJECTED',reason:'MEDIA_REFERENCE_REQUIRED'};
      body[message.kind]={...(providerId?{id:providerId}:{link:message.media.url}),...(message.kind==='audio'?{}:{caption:message.text}),...(message.kind==='document'?{filename:message.media.filename}:{})}; }
    try { const response=await this.request(`${this.config.phoneNumberId}/messages`,'POST',body); const id=response.messages?.[0]?.id; return id ? {status:'ACCEPTED',providerMessageId:String(id)} : {status:'UNKNOWN',reason:'PROVIDER_RESPONSE_WITHOUT_MESSAGE_ID'}; } catch(error) {return result(error);}
  }
  async upload(bytes:Uint8Array,mimeType:string,filename:string):Promise<string> { const form=new FormData(); form.set('messaging_product','whatsapp');form.set('type',mimeType);form.set('file',new Blob([new Uint8Array(bytes)],{type:mimeType}),filename); const response=await this.fetcher(`${this.origin}/${this.config.graphVersion}/${this.config.phoneNumberId}/media`,{method:'POST',headers:{Authorization:`Bearer ${this.config.token}`},body:form,redirect:'error',signal:AbortSignal.timeout(this.config.timeoutMs ?? 15_000)}); if(!response.ok) throw new ProviderError('MEDIA_UPLOAD_FAILED',response.status); const data=await response.json() as {id?:string}; if(!data.id) throw new ProviderError('MEDIA_UPLOAD_RESPONSE_INVALID'); return data.id; }
  async health() { try { const account=await this.request(`${this.config.phoneNumberId}?fields=id,quality_rating,verified_name`); return [signal('transport','OK','GRAPH_READ_SUCCEEDED'),signal('quality',account.quality_rating==='RED'?'BLOCKED':account.quality_rating==='YELLOW'?'WARNING':account.quality_rating==='GREEN'?'OK':'UNKNOWN',account.quality_rating ?? null,account.quality_rating?'supported':'not_available')]; } catch(error) { return [signal('transport','UNKNOWN',error instanceof ProviderError?error.code:'GRAPH_UNREACHABLE')]; } }
  async lifecycle():Promise<{status:string}> { throw new ProviderError('CLOUD_LIFECYCLE_MANAGED_BY_META_ONBOARDING'); }
  async qr():Promise<{mimeType:string;data:string;expiresAt:string}> { throw new ProviderError('CLOUD_QR_REQUIRES_ELIGIBLE_EMBEDDED_SIGNUP'); }
  async media(reference:{providerId?:string}) { if(!reference.providerId||!/^[\w.-]+$/.test(reference.providerId)) throw new ProviderError('MEDIA_REFERENCE_INVALID'); const metadata=await this.request(reference.providerId); const url=new URL(String(metadata.url)); if(url.protocol!=='https:' || !(url.hostname==='lookaside.fbsbx.com'||url.hostname.endsWith('.facebook.com')||url.hostname.endsWith('.fbsbx.com'))) throw new ProviderError('MEDIA_ORIGIN_DENIED'); const response=await this.fetcher(url,{headers:{Authorization:`Bearer ${this.config.token}`},redirect:'error',signal:AbortSignal.timeout(this.config.timeoutMs ?? 15_000)}); return {bytes:await limitedBytes(response),mimeType:String(metadata.mime_type ?? response.headers.get('content-type') ?? 'application/octet-stream')}; }
}
