/** Exact conversion between a typed price and minor units for the currency's
 * decimals, without floating-point rounding. */
function currencyDigits(currency:string){
 const digits=new Intl.NumberFormat('es-MX',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;
 if(typeof digits!=='number'||!Number.isSafeInteger(digits)||digits<0||digits>6)throw Error('MARKET_PRICE_INVALID');return digits;
}
export function marketPriceText(amount:number,currency:string):string{
 if(!Number.isSafeInteger(amount)||amount<0)throw Error('MARKET_PRICE_INVALID');
 const digits=currencyDigits(currency);
 const raw=String(amount).padStart(digits+1,'0');return digits?raw.slice(0,-digits)+'.'+raw.slice(-digits):raw;
}
export function marketPriceMinor(text:string,currency:string):number{
 const digits=currencyDigits(currency);
 if(!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text))throw Error('MARKET_PRICE_INVALID');
 const[whole,fraction='']=text.split('.');if(fraction.length>digits)throw Error('MARKET_PRICE_INVALID');
 const amount=BigInt(whole!)*10n**BigInt(digits)+BigInt(fraction.padEnd(digits,'0')||'0');
 if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw Error('MARKET_PRICE_INVALID');return Number(amount);
}
