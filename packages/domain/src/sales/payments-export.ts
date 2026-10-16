import {paymentRegisterSchema,paymentLabels,type PaymentRegister} from '../../../contracts/src/payments-register.js';

export const PAYMENT_EXPORT_MAX_BYTES=16*1024*1024;
const noData='Sin dato';
const headers=['Fecha UTC','Producto padre','Variante','País / mercado','Importe (unidades menores)','Moneda','Método','Estado','Número','Campaña','Anuncio','Contacto','Comprobante','Conversación','Ingreso aprobado (unidades menores)'];
/** Only authenticated application paths, never blob URLs or storage keys. */
export function paymentExportRows(value:PaymentRegister):string[][]{
 const data=paymentRegisterSchema.parse(value);
 if(data.offset!==0||data.rows.length!==data.total)throw new Error('PAYMENTS_EXPORT_INCOMPLETE');
 return[headers,...data.rows.map(r=>[r.occurredAt,r.familyName??noData,r.variantName??r.variantId??noData,r.market??noData,r.amountMinor??noData,r.currency??noData,
  r.method==='BANK_TRANSFER'?'Transferencia':r.method==='LINK'?'Link':noData,paymentLabels[r.status],r.accountMasked??noData,r.campaignId??noData,r.adId??noData,r.contactMasked??noData,
  r.assetId?`/sales/receipts?receipt=${r.receiptId}`:noData,r.conversationId?`/sales/inbox?conversation=${r.conversationId}`:noData,r.recognizedRevenueMinor]),[],
  ['Totales del filtro','Moneda','Ingreso aprobado (unidades menores)','Pagos aprobados'],...data.totals.map(t=>['Total',t.currency,t.approvedRevenueMinor,String(t.approvedPayments)]),[],
  ['Observado UTC',data.observedAt],['Zona del filtro',data.timezone],['Comprobantes',String(data.total)]];
}
export function csvCell(value:string):string{
 // Quoting alone does not stop spreadsheet formulas. Prefix dangerous leading
 // characters even when hidden behind whitespace, BOM or control characters.
 let start=0;while(start<value.length&&(value.charCodeAt(start)<=32||value.charCodeAt(start)===127||/\s/u.test(value[start]!)||value.charCodeAt(start)===65279))start++;
 const safe='=+-@'.includes(value[start]??'\0')||['\t','\r','\n'].includes(value[0]??'')?"'"+value:value;
 return '"'+safe.replaceAll('"','""')+'"';
}
function bounded(value:Buffer){if(value.length>PAYMENT_EXPORT_MAX_BYTES)throw new Error('PAYMENTS_EXPORT_BYTES');return value;}
export function paymentsCsv(value:PaymentRegister){return bounded(Buffer.from('\ufeff'+paymentExportRows(value).map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n','utf8'));}
function xml(value:string):string{return Array.from(value,ch=>{const code=ch.codePointAt(0)!;return code<32&&![9,10,13].includes(code)||code>=0xd800&&code<=0xdfff||code===0xfffe||code===0xffff?'�':ch;}).join('').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');}
function column(n:number){let result='';for(n++;n>0;n=Math.floor((n-1)/26))result=String.fromCharCode(65+(n-1)%26)+result;return result;}
function crc32(data:Buffer){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}return(crc^0xffffffff)>>>0;}
/** Small bounded ZIP writer: stored entries only, fixed names, no ZIP64,
 * timestamps or compression claims. Consumer tests use an independent reader. */
function zip(files:Record<string,string>){
 const local:Buffer[]=[],central:Buffer[]=[];let offset=0,size=0;
 for(const[path,text]of Object.entries(files)){
  const name=Buffer.from(path),data=Buffer.from(text),crc=crc32(data),header=Buffer.alloc(30),directory=Buffer.alloc(46);
  if(data.length+offset>PAYMENT_EXPORT_MAX_BYTES)throw new Error('PAYMENTS_EXPORT_BYTES');
  header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);
  header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
  directory.writeUInt32LE(0x02014b50);directory.writeUInt16LE(20,4);directory.writeUInt16LE(20,6);directory.writeUInt16LE(0x800,8);directory.writeUInt16LE(33,14);
  directory.writeUInt32LE(crc,16);directory.writeUInt32LE(data.length,20);directory.writeUInt32LE(data.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(offset,42);
  local.push(header,name,data);central.push(directory,name);offset+=header.length+name.length+data.length;size+=directory.length+name.length;
 }
 const end=Buffer.alloc(22),count=Object.keys(files).length;end.writeUInt32LE(0x06054b50);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(size,12);end.writeUInt32LE(offset,16);
 return bounded(Buffer.concat([...local,...central,end]));
}
export function paymentsXlsx(value:PaymentRegister){
 const rows=paymentExportRows(value);const sheet=rows.map((row,i)=>`<row r="${i+1}">${row.map((cell,j)=>`<c r="${column(j)}${i+1}" t="inlineStr"><is><t xml:space="preserve">${xml(cell)}</t></is></c>`).join('')}</row>`).join('');
 return zip({
  '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Pagos" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`,
 });
}
