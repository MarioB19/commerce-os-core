import { canonicalIdentity, eventDigest } from './security.js';
import type { CanonicalEvent, MessageKind } from './types.js';
const object = (v: unknown): Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, any> : {};
function at(value: unknown, fallback: string): string { const number = Number(value); if (Number.isFinite(number) && number > 0) { const d = new Date(number < 1e12 ? number * 1000 : number); if (!Number.isNaN(d.getTime())) return d.toISOString(); } return fallback; }
/** Safe scalar telemetry only. Missing provider time never falls back to local receipt. */
export function explicitProviderTimestamp(provider:string,input:unknown,phoneNumberId?:string):{provider_event_at:string;provider_timestamp_count:number}|null{
 const raw=object(input),values:unknown[]=[];
 if(provider==='waha')values.push(object(raw.payload).timestamp??raw.timestamp);
 else if(provider==='cloud')for(const entry of Array.isArray(raw.entry)?raw.entry:[])for(const change of Array.isArray(object(entry).changes)?object(entry).changes:[]){const value=object(object(change).value);if(phoneNumberId&&value.metadata?.phone_number_id!==phoneNumberId)continue;for(const event of [...(Array.isArray(value.messages)?value.messages:[]),...(Array.isArray(value.statuses)?value.statuses:[])])values.push(object(event).timestamp);}
 else if(provider==='simulator'&&typeof raw.provider_at==='string'){const parsed=Date.parse(raw.provider_at);if(Number.isFinite(parsed))return{provider_event_at:new Date(parsed).toISOString(),provider_timestamp_count:1};}
 const timestamps=values.filter(v=>typeof v==='number'||typeof v==='string'&&/^\d+(\.\d+)?$/.test(v)).map(v=>at(v,'')).filter(Boolean);return timestamps.length?{provider_event_at:timestamps.sort()[0]!,provider_timestamp_count:timestamps.length}:null;
}
export function normalizeWaha(input: unknown, receivedAt: string): CanonicalEvent[] {
  const envelope = object(input), payload = object(envelope.payload), event = String(envelope.event ?? 'unknown');
  const groupCandidate=payload.fromMe?payload.to:payload.from;
  const groupId=[groupCandidate,payload.chatId,payload.group?.id].find(v=>typeof v==='string'&&/^[\d-]+@g\.us$/.test(v));
  const group=groupId?{groupId,receivingSession:String(envelope.session??''),senderIdentity:typeof payload.participant==='string'?canonicalIdentity(payload.participant):undefined,participantIdentity:typeof payload.participant==='string'?canonicalIdentity(payload.participant):undefined}:{};
  const base = { ...group, key: String(envelope.id ?? eventDigest(JSON.stringify(input))), providerAt: at(payload.timestamp ?? envelope.timestamp, receivedAt), payload };
  if (event === 'message' || event === 'message.any') {
    if (!payload.id || !payload.from) throw new Error('WAHA_MESSAGE_IDENTITY_REQUIRED');
    const mime = String(payload.media?.mimetype ?? '');
    const kind: CanonicalEvent['kind'] = payload.hasMedia ? (mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'document') : 'text';
    const aliases: string[] = [];
    if (typeof payload.fromAlt === 'string') aliases.push(canonicalIdentity(payload.fromAlt));
    return [{ ...base, key: groupId?`message:${payload.id}:${envelope.session??''}`:`message:${payload.id}`, type: 'message', providerMessageId: String(payload.id), identity: canonicalIdentity(String(payload.fromMe ? payload.to : payload.from)), identityAliases: aliases, fromMe: !!payload.fromMe, text: typeof payload.body === 'string' ? payload.body : '', kind,
      ...(payload.media ? { media: { url: payload.media.url, mimeType: payload.media.mimetype, filename: payload.media.filename } } : {}),
      ...(payload.referral && typeof payload.referral === 'object' ? { referral: payload.referral } : {}) }];
  }
  if (event === 'message.ack') return [{ ...base, key: groupId?`ack:${payload.id}:${payload.ack}:${envelope.session??''}:${payload.participant??'global'}`:`ack:${payload.id}:${payload.ack}`, type: 'ack', providerMessageId: String(payload.id), status: ({ '-1': 'FAILED', 0: 'PENDING', 1: 'SENT', 2: 'DELIVERED', 3: 'READ', 4: 'PLAYED' } as Record<string, string>)[String(payload.ack)] ?? 'UNKNOWN' }];
  if(event.startsWith('group.')&&groupId)return[{...base,type:'group_membership',status:event}];
  if (event === 'session.status') return [{ ...base, type: 'session', status: String(payload.status ?? 'UNKNOWN') }];
  return [{ ...base, type: 'unhandled', status: event }];
}
export function normalizeCloud(input: unknown, receivedAt: string, phoneNumberId?: string): CanonicalEvent[] {
  const envelope = object(input); if (envelope.object !== 'whatsapp_business_account') throw new Error('CLOUD_OBJECT_INVALID');
  const result: CanonicalEvent[] = [];
  for (const entry of Array.isArray(envelope.entry) ? envelope.entry : []) for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
    const value = object(change.value);
    if (phoneNumberId && value.metadata?.phone_number_id !== phoneNumberId) continue;
    for (const raw of Array.isArray(value.messages) ? value.messages : []) {
      const m = object(raw); if (!m.id || !m.from) throw new Error('CLOUD_MESSAGE_IDENTITY_REQUIRED');
      const supported = ['text','image','audio','document'].includes(m.type);
      result.push({ key: `message:${m.id}`, type: 'message', providerAt: at(m.timestamp, receivedAt), identity: canonicalIdentity(String(m.from)), providerMessageId: String(m.id), fromMe: false, kind: supported ? m.type as MessageKind : 'unsupported', text: m.type === 'text' ? String(m.text?.body ?? '') : String(m[m.type]?.caption ?? ''), ...(m[m.type]?.id ? { media: { providerId: m[m.type].id, mimeType: m[m.type].mime_type, filename: m[m.type].filename, sha256: m[m.type].sha256 } } : {}), ...(m.referral ? { referral: object(m.referral) } : {}), payload: m });
    }
    for (const s of Array.isArray(value.statuses) ? value.statuses : []) result.push({ key: `ack:${s.id}:${s.status}:${s.timestamp}`, type: 'ack', providerMessageId: String(s.id), status: String(s.status).toUpperCase(), providerAt: at(s.timestamp, receivedAt), payload: object(s) });
    if (change.field !== 'messages') result.push({ key: eventDigest(JSON.stringify(change)), type: 'restriction', status: String(change.field), providerAt: receivedAt, payload: value });
  }
  return result;
}

/** Closed local fixture protocol. It never accepts provider supplied executable instructions. */
export function normalizeSimulator(input:unknown,receivedAt:string):CanonicalEvent[]{const raw=object(input),type:CanonicalEvent['type']=raw.type==='ack'?'ack':raw.type==='group_membership'?'group_membership':'message';return[{...(raw.group_id?{groupId:String(raw.group_id),senderIdentity:canonicalIdentity(String(raw.sender_identity??'')),participantIdentity:raw.participant_identity?canonicalIdentity(String(raw.participant_identity)):undefined,receivingSession:String(raw.receiving_session??'')}:{}),fromMe:raw.from_me===true,key:String(raw.id??eventDigest(JSON.stringify(input))),type,providerAt:String(raw.provider_at??receivedAt),identity:canonicalIdentity(String(raw.identity??'simulation-contact')),providerMessageId:typeof raw.provider_message_id==='string'?raw.provider_message_id:undefined,text:String(raw.text??'Hola'),kind:raw.kind??'text',status:raw.status,...(raw.media?{media:{providerId:raw.media.providerId??raw.media.provider_id,url:raw.media.url,mimeType:raw.media.mimeType??raw.media.mime_type,filename:raw.media.filename}}:{}),payload:raw}];}
