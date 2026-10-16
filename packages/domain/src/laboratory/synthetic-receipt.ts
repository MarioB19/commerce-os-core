/** V7 RF-19.p: the example receipt the automatic buyer sends. A one-page PDF
 * written here (no library), clearly marked as a test, for the price of the
 * variant. The account and holder are placeholders: a test never uses the
 * business's real account (the laboratory assumes they match and says so). */
export interface SyntheticReceipt {amountMinor:number;currency:string;minorDigits:number;paidOn:string;reference:string}
const ascii=(v:string)=>v.normalize('NFKD').replace(/[^\x20-\x7e]/g,'').replace(/[\\()]/g,m=>'\\'+m);
export function syntheticReceiptLines(r:SyntheticReceipt){
 const amount=(r.amountMinor/10**r.minorDigits).toFixed(r.minorDigits);
 return['COMPROBANTE DE TRANSFERENCIA - PRUEBA (Commerce OS)','Estado: Completada',`Monto: ${amount} ${r.currency}`,`Fecha: ${r.paidOn}`,
  `Referencia: ${r.reference}`,'Cuenta destino: 012180000000000000 (prueba)','Beneficiario: Negocio de prueba','Concepto: Compra de prueba'];
}
export function syntheticReceiptPdf(r:SyntheticReceipt):Buffer{
 if(!Number.isSafeInteger(r.amountMinor)||r.amountMinor<=0||!/^[A-Z]{3}$/.test(r.currency)||!/^\d{4}-\d{2}-\d{2}$/.test(r.paidOn)||!/^[A-Z0-9-]{4,40}$/.test(r.reference)||![0,2,3].includes(r.minorDigits))throw Error('LAB_SYNTHETIC_RECEIPT');
 const text=syntheticReceiptLines(r).map((line,i)=>`BT /F1 ${i===0?14:12} Tf 72 ${740-i*24} Td (${ascii(line)}) Tj ET`).join('\n');
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  `<< /Length ${Buffer.byteLength(text,'latin1')} >>\nstream\n${text}\nendstream`];
 let out='%PDF-1.4\n';const offsets:number[]=[];
 objects.forEach((body,i)=>{offsets.push(Buffer.byteLength(out,'latin1'));out+=`${i+1} 0 obj\n${body}\nendobj\n`;});
 const xref=Buffer.byteLength(out,'latin1');
 out+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('');
 out+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 return Buffer.from(out,'latin1');
}
