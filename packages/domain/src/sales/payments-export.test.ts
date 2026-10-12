import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
import {paymentFilterSchema,paymentPageQuerySchema,paymentRegisterSchema,type PaymentRegister} from '../../../contracts/src/payments-register.js';
import {paymentsCsv,paymentsXlsx,paymentExportRows,csvCell} from './payments-export.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function sample():PaymentRegister{return{workspaceId:'one',filters:paymentFilterSchema.parse({from:'2026-10-01',to:'2026-10-31'}),rows:[{receiptId:id(1),receiptVersion:3,contributionId:id(2),orderId:id(3),conversationId:id(4),occurredAt:'2026-10-12T00:00:00.000Z',
 familyId:id(5),familyName:'Producto sintético',variantId:id(6),market:'México',amountMinor:'9007199254740991',currency:'MXN',method:'BANK_TRANSFER',status:'APPROVED',
 accountId:id(7),accountMasked:'••••0001',contactMasked:'••••0002',campaignId:'100',adId:'101',assetId:id(8),recognizedRevenueMinor:'9007199254740991',duplicate:false}],
 total:1,totals:[{currency:'MXN',approvedRevenueMinor:'18014398509481982',approvedPayments:2}],timezone:'America/Mexico_City',observedAt:'2026-10-12T01:00:00.000Z',limit:50,offset:0};}
function python(script:string,input:Buffer){const result=spawnSync('python3',['-c',script],{input,encoding:'utf8',maxBuffer:2*1024*1024,timeout:10000});expect(result.status,result.stderr).toBe(0);return JSON.parse(result.stdout);}

describe('V7 payment register contracts and exports',()=>{
 it.each(['2026-02-29','2026-13-01','2026-01-00','tomorrow'])('rejects noncalendar date %s',from=>expect(()=>paymentFilterSchema.parse({from,to:'2026-12-31'})).toThrow());
 it('rejects reversed and oversized windows, profile selectors and unbounded pages',()=>{
  for(const value of [{from:'2026-12-01',to:'2026-01-01'},{from:'2025-01-01',to:'2026-01-03'},{from:'2026-01-01',to:'2026-01-02',workspaceId:'foreign'}])expect(()=>paymentFilterSchema.parse(value)).toThrow();
  expect(()=>paymentPageQuerySchema.parse({from:'2026-01-01',to:'2026-01-02',limit:101})).toThrow();
 });
 it('normalizes UUID identity and permits literal wildcard search without SQL syntax',()=>{
  const query=paymentFilterSchema.parse({from:'2026-01-01',to:'2026-01-02',familyId:'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',q:"%_'; drop table records;"});
  expect(query.familyId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');expect(query.q).toContain('%_');
 });
 it.each(['=SUM(1,1)',' +1','\t@evil','\r-2','\ufeff=NOW()','\u0001=1'])('neutralizes CSV formula %j',value=>expect(csvCell(value)).toBe('"\''+value+'"'));
 it('quotes delimiters/newlines without inventing monetary rounding',()=>{
  expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  const rows=python("import sys,io,csv,json;print(json.dumps(list(csv.reader(io.StringIO(sys.stdin.buffer.read().decode('utf-8-sig'))))))",paymentsCsv(sample()));
  expect(rows[1][4]).toBe('9007199254740991');expect(rows[4][2]).toBe('18014398509481982');
 });
 it('parses XLSX through independent ZIP/CRC and XML readers, preserving all exact values',()=>{
  const data=sample();data.rows[0].familyName='=HYPERLINK("https://invalid.example","x") & < >';
  const result=python(`import sys,io,zipfile,json,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));assert z.testzip() is None
n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
r=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
assert not r.findall('.//s:f',n)
assert all(c.attrib.get('t')=='inlineStr' for c in r.findall('.//s:c',n))
rows=[[c.find('s:is/s:t',n).text or '' for c in row] for row in r.find('s:sheetData',n)]
print(json.dumps({'names':z.namelist(),'rows':rows,'all_xml_valid':all(E.fromstring(z.read(name)) is not None for name in z.namelist())}))`,paymentsXlsx(data));
  expect(result.all_xml_valid).toBe(true);expect(result.names).toHaveLength(5);expect(result.names.every((name:string)=>!name.includes('external')&&!name.includes('vba'))).toBe(true);
  expect(result.rows).toEqual(paymentExportRows(data));expect(result.rows[1][1]).toBe(data.rows[0].familyName);
 });
 it('retains unknowns and contains no signed evidence URL or invented market',()=>{
  const data=sample();Object.assign(data.rows[0],{assetId:null,conversationId:null,variantId:null,market:null,amountMinor:null,currency:null,method:'UNKNOWN',accountMasked:null,contactMasked:null});
  const rows=paymentExportRows(data);expect(rows[1].slice(2,7)).toEqual(Array(5).fill('Sin dato'));expect(rows[1][12]).toBe('Sin dato');expect(rows[1][13]).toBe('Sin dato');
  expect(paymentsCsv(data).toString()).not.toMatch(/signature|storage_key|access_token/);
 });
 it('replaces XML-forbidden controls and lone surrogates while retaining Unicode and whitespace',()=>{
  const data=sample();data.rows[0].familyName='A\u0001B\ud800C\uffffD 😀\t\n';
  const result=python(`import sys,io,zipfile,json,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
r=E.fromstring(z.read('xl/worksheets/sheet1.xml'))
print(json.dumps(r.find('s:sheetData',n)[1][1].find('s:is/s:t',n).text))`,paymentsXlsx(data));
  expect(result).toBe('A�B�C�D 😀\t\n');
 });
 it('keeps all five labels and per-currency total rows distinct',()=>{
  const data=sample(),statuses=['APPROVED','REVIEW','REJECTED','TEST','FALSE'] as const;
  data.rows=statuses.map((status,i)=>({...data.rows[0],receiptId:id(i+10),status}));data.total=5;data.totals.push({currency:'USD',approvedRevenueMinor:'7',approvedPayments:1});
  const rows=paymentExportRows(data);expect(rows.slice(1,6).map(r=>r[7])).toEqual(['Aprobado','Por revisar','Rechazado','Prueba','Falso']);expect(rows.find(r=>r[1]==='USD')).toEqual(['Total','USD','7','1']);
 });
 it('rejects a paginated or incomplete export before producing bytes',()=>{
  expect(()=>paymentsCsv({...sample(),offset:1})).toThrow('PAYMENTS_EXPORT_INCOMPLETE');expect(()=>paymentsXlsx({...sample(),total:2})).toThrow('PAYMENTS_EXPORT_INCOMPLETE');
 });
 it('rejects unmasked contact, storage fields and floating amounts in the closed response',()=>{
  for(const extra of [{contactMasked:'+15550000002'},{storage_key:'not-exported'},{amountMinor:'1.01'}])expect(()=>paymentRegisterSchema.parse({...sample(),rows:[{...sample().rows[0],...extra}]})).toThrow();
 });
 it('represents an empty observed register with headers and explicit zero count',()=>{
  const data={...sample(),rows:[],total:0,totals:[]};expect(paymentExportRows(data).at(-1)).toEqual(['Comprobantes','0']);expect(paymentsXlsx(data).readUInt32LE(0)).toBe(0x04034b50);
 });
});
