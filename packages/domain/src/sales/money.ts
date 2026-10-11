/** Parse decimal amounts without float multiplication or silent absolute values. */
export function decimalMinor(value:unknown,currency='MXN'):number {
 const digits=new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits??2;
 const match=String(value).match(/^(0|[1-9]\d*)(?:\.(\d+))?$/);if(!match||((match[2]?.slice(digits)??'').replace(/0/g,'')))throw new Error('INVALID_AMOUNT');
 const amount=BigInt(match[1]!)*10n**BigInt(digits)+BigInt((match[2]??'').slice(0,digits).padEnd(digits,'0')||'0');
 if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('INVALID_AMOUNT');return Number(amount);
}
export function ratios(spend:number|null,revenue:number,sales:number){return{cpa_minor:spend!==null&&sales>0?spend/sales:null,roas:spend!==null&&spend>0?revenue/spend:null,balance_minor:spend===null?null:revenue-spend};}
