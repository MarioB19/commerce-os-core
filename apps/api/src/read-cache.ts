/** Bounded process-local read cache. Call only after authentication and scope validation. */
export class ReadCache<T> {
  private values=new Map<string,{value:T;expires:number}>();
  private running=new Map<string,Promise<{value:T;expires:number}>>();
  constructor(private ttlMs:number,private maxEntries=128,private now=Date.now){}
  async get(key:string,read:()=>Promise<T>){
    const now=this.now(),cached=this.values.get(key);
    if(cached&&cached.expires>now)return{value:structuredClone(cached.value),cache:{status:'HIT' as const,ttl_ms:this.ttlMs,expires_at:new Date(cached.expires).toISOString()}};
    if(cached)this.values.delete(key);
    const pending=this.running.get(key);let operation=pending;
    if(!operation){operation=(async()=>{const value=await read(),entry={value:structuredClone(value),expires:this.now()+this.ttlMs};if(this.values.size>=this.maxEntries)this.values.delete(this.values.keys().next().value!);this.values.set(key,entry);return entry;})();this.running.set(key,operation);}
    try{const entry=await operation;return{value:structuredClone(entry.value),cache:{status:pending?'COALESCED' as const:'MISS' as const,ttl_ms:this.ttlMs,expires_at:new Date(entry.expires).toISOString()}};}finally{if(this.running.get(key)===operation)this.running.delete(key);}
  }
}
