import {decimalMinor} from './money.js';
type Row=Record<string,unknown>;
export function parseClickChat(row:Row,options:{dateFormat:'DMY'|'MDY';defaultCurrency?:string}){
 const fields=Object.fromEntries(Object.entries(row).map(([k,v])=>[k.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase(),String(v??'').trim()]));
 const issues:string[]=[],warnings:string[]=[];
 let date=fields.FECHA??fields.DATE??'';
 if(/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(date)){const [a,b,y]=date.split('/');date=options.dateFormat==='DMY'?`${y}-${b!.padStart(2,'0')}-${a!.padStart(2,'0')}`:`${y}-${a!.padStart(2,'0')}-${b!.padStart(2,'0')}`;}
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)issues.push('INVALID_DATE');
 const currency=fields.MONEDA??fields.CURRENCY??options.defaultCurrency;if(!fields.MONEDA&&!fields.CURRENCY&&currency)warnings.push('CURRENCY_ASSUMED');
 let amount:number|null=null;try{if(!currency||!Intl.supportedValuesOf('currency').includes(currency))throw Error();const input=(fields['PAGO RECIBIDO']??fields.AMOUNT??'').replace(/^\$\s*/,'');const clean=/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(input)?input.replaceAll(',',''):/^\d+,\d{1,2}$/.test(input)?input.replace(',','.'):input;amount=decimalMinor(clean,currency);if(amount<=0)issues.push('AMOUNT_REQUIRED');}catch{issues.push('INVALID_AMOUNT_OR_CURRENCY');}
 const ad=fields['AD ID']??fields.AD_ID??null,post=fields['POST ID']??fields.POST_ID;
 if(post&&!ad)warnings.push('POST_ID_IS_NOT_AD_ID');if(ad&&!/^\d+$/.test(ad))issues.push('INVALID_AD_ID');
 const marker=/\b(prueba|test|fallo|fallid[oa])\b/i.test(fields.NOMBRE??'');if(marker)warnings.push('LEGACY_NAME_MARKER_REQUIRES_REVIEW');
 const productId=fields.PRODUCT_ID||null;if(productId&&!/^[0-9a-f-]{36}$/i.test(productId))issues.push('INVALID_PRODUCT_ID');
 return{external_id:fields.SALE_ID??fields.ID??null,date,amount_minor:amount,currency:currency??null,currency_source:fields.MONEDA||fields.CURRENCY?'source':'configuration',product_id:productId,product_label:fields.PRODUCTO??null,ad_id:ad,identifier_type:ad?'ad':post?'post':'unknown',classification:'REPORTED',legacy_marker:marker,evidence_verified:false,issues,warnings};
}
