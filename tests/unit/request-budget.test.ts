import {expect,it} from 'vitest';
import {apiFailureDiagnostic,createRollingRequestBudget} from '../support/request-budget.js';

it('reserves a whole batch before dispatch within every rolling window',async()=>{
 let now=0;const waits:number[]=[],sent:{at:number;cost:number}[]=[];
 const reserve=createRollingRequestBudget({now:()=>now,wait:async ms=>{waits.push(ms);now+=ms;}});
 for(const cost of [218,3,217,1]){await reserve(cost);sent.push({at:now,cost});}
 expect(waits).toEqual([60100,60100]);
 for(const end of sent)expect(sent.filter(r=>r.at>end.at-60100&&r.at<=end.at).reduce((sum,r)=>sum+r.cost,0)).toBeLessThanOrEqual(220);
});

it('does not reset a full client window before an offset server window expires',async()=>{
 let now=5000;const waits:number[]=[];
 const reserve=createRollingRequestBudget({now:()=>now,wait:async ms=>{waits.push(ms);now+=ms;}});
 await reserve(1);now=59000;await reserve(200);now=60100;
 // The former fixed-window helper allowed 100 here, totaling 301 since t=5000.
 await reserve(100);expect(now).toBe(119100);expect(waits).toEqual([5000,54000]);
});

it('rechecks after early timer wake-up and competing reservations',async()=>{
 let now=0;let calls=0;
 const reserve=createRollingRequestBudget({limit:2,windowMs:100,now:()=>now,wait:async ms=>{now+=++calls===1?ms-1:ms;}});
 await reserve(2);await Promise.all([reserve(1),reserve(1)]);expect(now).toBe(100);expect(calls).toBeGreaterThanOrEqual(2);
});

it('rejects invalid or oversized costs before waiting',async()=>{
 const reserve=createRollingRequestBudget({wait:async()=>{throw Error('WAIT_NOT_EXPECTED');}});
 for(const cost of [0,-1,221,1.5,NaN])await expect(reserve(cost)).rejects.toThrow('INVALID_REQUEST_COST');
});

it('captures HTTP and pool categories without raw messages, stack, payload or credentials',()=>{
 const pool={totalCount:5,idleCount:0,waitingCount:2};
 expect(apiFailureDiagnostic(Object.assign(new Error('Rate limit exceeded, retry in 1 second'),{statusCode:429}),pool)).toEqual({name:'Error',code:null,status:429,category:'RATE_LIMIT_EXCEEDED',pool:{total:5,idle:0,waiting:2}});
 expect(apiFailureDiagnostic(new Error('timeout exceeded when trying to connect'),pool).category).toBe('DATABASE_CONNECTION_TIMEOUT');
 const result=apiFailureDiagnostic({name:'private-name',code:'postgres://secret',statusCode:700,message:'secret query password',stack:'private stack',body:{token:'secret'}},pool);
 expect(result).toEqual({name:'OTHER',code:null,status:500,category:'UNCLASSIFIED',pool:{total:5,idle:0,waiting:2}});expect(JSON.stringify(result)).not.toMatch(/secret|password|private|query|stack|token/);
});
