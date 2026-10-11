/** Test transport pacing only. Reserve every HTTP request, including batch children,
 * before dispatch; never retry a rejected request or change the API rate limit. */
export function createRollingRequestBudget(options:{limit?:number;windowMs?:number;now?:()=>number;wait?:(ms:number)=>Promise<void>}={}){
 const limit=options.limit??220,windowMs=options.windowMs??60100,now=options.now??(()=>performance.now()),wait=options.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms)));
 if(!Number.isInteger(limit)||limit<1||!Number.isFinite(windowMs)||windowMs<1)throw new Error('INVALID_REQUEST_BUDGET');
 let reservations:{at:number;cost:number}[]=[];
 return async(cost=1)=>{
  if(!Number.isInteger(cost)||cost<1||cost>limit)throw new Error('INVALID_REQUEST_COST');
  for(;;){
   const at=now();reservations=reservations.filter(r=>r.at+windowMs>at);
   if(reservations.reduce((sum,r)=>sum+r.cost,0)+cost<=limit){reservations.push({at,cost});return;}
   await wait(Math.max(1,reservations[0]!.at+windowMs-at));
  }
 };
}

/** Closed diagnostic vocabulary: never retain query text, body, headers, raw error
 * messages or stack traces from a test API that has private configuration. */
export function apiFailureDiagnostic(error:unknown,pool:{totalCount:number;idleCount:number;waitingCount:number}){
 const e=error as {name?:unknown;code?:unknown;statusCode?:unknown;message?:unknown};
 const message=typeof e?.message==='string'?e.message:'';
 const category=message.startsWith('Rate limit exceeded, retry in ')?'RATE_LIMIT_EXCEEDED':
  ['timeout exceeded when trying to connect','Connection terminated due to connection timeout'].includes(message)?'DATABASE_CONNECTION_TIMEOUT':'UNCLASSIFIED';
 return {
  name:['Error','TypeError','RangeError'].includes(String(e?.name))?String(e.name):'OTHER',
  code:typeof e?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(e.code)?e.code:null,
  status:Number.isInteger(e?.statusCode)&&Number(e.statusCode)>=400&&Number(e.statusCode)<=599?Number(e.statusCode):500,
  category,
  pool:{total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount},
 };
}
