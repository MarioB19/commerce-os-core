import {ProviderError} from './types.js';

type WebhookTarget={url:string;hmacKey:string};
const events=['message','message.ack','session.status'];
const object=(value:unknown):Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};

/** Only booleans/enums leave the adapter. Remote configuration can contain secrets. */
export function webhookConfiguration(config:unknown,target:WebhookTarget){
  const hooks=object(config).webhooks;
  const same=Array.isArray(hooks)?hooks.filter(h=>object(h).url===target.url):[];
  const destination=same.length===1,hook=object(same[0]);
  const subscribed=destination&&Array.isArray(hook.events)&&events.every(e=>hook.events.includes(e));
  const authentication=destination&&object(hook.hmac).key===target.hmacKey;
  const expected=new URL(target.url),prefix=expected.pathname.slice(0,expected.pathname.lastIndexOf('/')+1);
  const obsolete=Array.isArray(hooks)&&hooks.some(h=>{try{const u=new URL(object(h).url);return u.origin===expected.origin&&u.pathname.startsWith(prefix)&&u.href!==expected.href;}catch{return true;}});
  const matches=destination&&subscribed&&authentication&&!obsolete;
  return{matches,destination_matches:destination,events_match:subscribed,authentication_matches:authentication,reason:matches?'WEBHOOK_CONFIGURED':'WEBHOOK_CONFIGURATION_MISMATCH'};
}

/** Replace only this workspace's Commerce callback; preserve engine/options and external hooks. */
export function reconcileWebhook(value:unknown,target:WebhookTarget){
  if(value!==undefined&&value!==null&&(typeof value!=='object'||Array.isArray(value)))throw new ProviderError('WEBHOOK_CONFIGURATION_INVALID');
  const config=object(value),hooks=config.webhooks??[];
  if(!Array.isArray(hooks))throw new ProviderError('WEBHOOK_CONFIGURATION_INVALID');
  const expected=new URL(target.url),prefix=expected.pathname.slice(0,expected.pathname.lastIndexOf('/')+1);
  const retained=hooks.filter(h=>{
    if(typeof object(h).url!=='string')throw new ProviderError('WEBHOOK_CONFIGURATION_INVALID');
    const url=new URL(h.url);
    if(url.origin===expected.origin&&url.pathname.startsWith('/webhooks/waha/')&&!url.pathname.startsWith(prefix))throw new ProviderError('WEBHOOK_SCOPE_CONFLICT');
    return !(url.origin===expected.origin&&url.pathname.startsWith(prefix));
  });
  return{...config,webhooks:[...retained,{url:target.url,events:[...events],hmac:{key:target.hmacKey},retries:{delaySeconds:2,attempts:15,policy:'exponential'}}]};
}
