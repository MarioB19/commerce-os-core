/**
 * V7.5.3 (F3): canonical identity of a group message, per adapter contract.
 *
 * WAHA serializes a message key as `<fromMe>_<chat>_<id>[_<participant>]`.
 * The sender's own session and each receiving session serialize the same
 * group message differently: `fromMe` flips and the participant may come as
 * a phone JID or as a LID. The chat and the message ID are the stable part.
 * Only an ID that matches the full structure is reduced; anything else keeps
 * its literal value, so an unknown format never matches by accident.
 *
 * Simulator and Cloud IDs have no group structure here: they stay literal.
 * The original IDs remain stored for private audit; this key is derived.
 */
export interface GroupMessageIdentity {
 /** Comparison key. Equal keys mean "same message of the same chat". */
 key:string;
 structured:boolean;
 fromMe:boolean|null;
 chat:string|null;
 messageId:string|null;
 participant:string|null;
}

const WAHA_GROUP_MESSAGE=/^(true|false)_(\d{5,30}(?:-\d{1,20})?@g\.us)_([A-Za-z0-9]{6,128})_(\d{5,24}@(?:c\.us|s\.whatsapp\.net|lid))$/;

export function groupMessageIdentity(provider:string,raw:string|null|undefined):GroupMessageIdentity|null{
 if(typeof raw!=='string'||!raw||raw.length>512)return null;
 if(provider==='waha'){
  const match=WAHA_GROUP_MESSAGE.exec(raw);
  if(match)return{key:`waha-group:${match[2]}:${match[3]}`,structured:true,fromMe:match[1]==='true',chat:match[2]!,messageId:match[3]!,participant:match[4]!};
 }
 return{key:`literal:${provider}:${raw}`,structured:false,fromMe:null,chat:null,messageId:null,participant:null};
}

/** Same message of the same group, observed from two sessions: literal
 * equality, or two fully structured IDs with the same chat and message ID.
 * The stored effect ID may be the sender's form or, after the V7.5.1
 * evidence reconciliation, a receiver's form; both reduce to the same key.
 * Direction and participant checks belong to the caller, which knows the
 * authenticated sender and receiver. */
export function sameGroupMessage(provider:string,stored:string|null|undefined,observed:string|null|undefined):'LITERAL'|'CANONICAL'|null{
 if(typeof stored!=='string'||typeof observed!=='string'||!stored||!observed)return null;
 if(stored===observed)return'LITERAL';
 const a=groupMessageIdentity(provider,stored),b=groupMessageIdentity(provider,observed);
 return a&&b&&a.structured&&b.structured&&a.key===b.key?'CANONICAL':null;
}
