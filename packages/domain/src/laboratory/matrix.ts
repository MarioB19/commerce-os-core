/** V7.5.4: what a paid matrix still holds. Every suite started under the matrix
 * counts what it consumed across all its runs and attempts: confirmed (charged
 * by a settled attempt) plus uncertain (an attempt without a final state, or a
 * binding without attempt, counts its whole maximum). A suite that is still
 * open keeps at least its full maximum reserved; a terminal one (no running
 * case and no queued or in-flight step) keeps only what it consumed, so the
 * demonstrably unconsumed part is free for a continuation under the same
 * matrix and the same ceiling. Nothing here can raise the ceiling. */
export interface MatrixSuiteUsage {terminal:boolean;maximum_microusd:number;maximum_ai_calls:number;confirmed_microusd:number;uncertain_microusd:number;calls:number}
function need(ok:unknown,code:string):asserts ok{if(!ok)throw Error(code);}
const count=(v:number)=>Number.isSafeInteger(v)&&v>=0;
export function matrixReservation(suites:readonly MatrixSuiteUsage[]){
 let reserved_microusd=0,reserved_ai_calls=0,consumed_microusd=0,uncertain_microusd=0,calls=0;
 for(const s of suites){
  need([s.maximum_microusd,s.maximum_ai_calls,s.confirmed_microusd,s.uncertain_microusd,s.calls].every(count),'LAB_MATRIX_USAGE_INVALID');
  const used=s.confirmed_microusd+s.uncertain_microusd;
  reserved_microusd+=s.terminal?used:Math.max(s.maximum_microusd,used);
  reserved_ai_calls+=s.terminal?s.calls:Math.max(s.maximum_ai_calls,s.calls);
  consumed_microusd+=s.confirmed_microusd;uncertain_microusd+=s.uncertain_microusd;calls+=s.calls;
 }
 return{reserved_microusd,reserved_ai_calls,consumed_microusd,uncertain_microusd,calls};
}
