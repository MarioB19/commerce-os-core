import {test,expect} from '@playwright/test';
import {closureFixture,closureProduct} from './support/closure-fixture.js';
// The full browser includes the native PDF viewer; headless-shell does not.
test.use({channel:'chromium'});
function wave(){
 const samples=8000,bytes=Buffer.alloc(44+samples*2);bytes.write('RIFF',0);bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(8000,24);bytes.writeUInt32LE(16000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(samples*2,40);for(let i=0;i<samples;i++)bytes.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/8000)*4000),44+i*2);return bytes;
}
test('plays an authenticated audio inside Conversations without downloading or sending messages',async({page})=>{
 await closureFixture(page);const mutations:string[]=[];
 await page.route('**/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;if(route.request().method()!=='GET'){mutations.push(path);return route.fallback();}
  if(path==='/v1/conversations/conversation-fixture')return route.fulfill({json:{data:{id:'conversation-fixture',version:7,account_id:'account-fixture',contact_id:'contact-fixture',status:'OPEN',stage:'COMMITTED',contact:{name:'Contacto ficticio'},controls:{takeover:true},messages:[{id:'audio-message',direction:'OUTBOUND',kind:'audio',asset_id:'audio-fixture',created_at:'2026-09-16T04:00:00Z'}],events:[],outbox:[]}}});
  if(path==='/v1/assets/audio-fixture/preview')return route.fulfill({json:{data:{kind:'file',name:'Audio de demostración',mime_type:'audio/wav',content_url:'/v1/assets/audio-fixture/content?environment=REAL&disposition=inline',download_url:'/v1/assets/audio-fixture/content?environment=REAL&disposition=attachment'}}});
  if(path==='/v1/assets/audio-fixture/content')return route.fulfill({contentType:'audio/wav',body:wave(),headers:{'Cache-Control':'private, no-store','Accept-Ranges':'bytes'}});
  return route.fallback();
 });
 await page.goto('/sales/inbox');await page.getByText('Contacto ficticio',{exact:true}).first().click();
 const audio=page.getByLabel('Audio: Audio de demostración');await expect(audio).toBeVisible();
 await expect.poll(()=>audio.evaluate((node:HTMLAudioElement)=>node.readyState)).toBeGreaterThanOrEqual(1);
 expect(await audio.evaluate((node:HTMLAudioElement)=>node.duration)).toBeCloseTo(1,1);
 await audio.evaluate(async(node:HTMLAudioElement)=>{node.muted=true;await node.play();});
 await expect.poll(()=>audio.evaluate((node:HTMLAudioElement)=>node.currentTime)).toBeGreaterThan(0);
 expect(mutations).toEqual([]);await page.screenshot({path:test.info().outputPath('audio-inline.png'),fullPage:true});
});
test('opens a resource and its access code only on explicit preview, with no public URL persistence',async({page})=>{
 await closureFixture(page);let previews=0;
 await page.route('**/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/v1/assets')return route.fulfill({json:{data:[{id:'access-fixture',name:'Portal de demostración',kind:'access',status:'READY'}]}});
  if(path==='/v1/assets/access-fixture/preview'){previews++;return route.fulfill({json:{data:{kind:'access',name:'Portal de demostración',url:'https://example.invalid/material',code:'DEMO-ONLY',instructions:'Acceso sintético para esta prueba'}}});}
  return route.fallback();
 });
 await page.goto('/catalog?product='+closureProduct.id+'&tab=offers');expect(previews).toBe(0);
 await page.getByRole('button',{name:'Ver material',exact:true}).click();await expect(page.getByText('DEMO-ONLY',{exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Abrir recurso'})).toHaveAttribute('href','https://example.invalid/material');
 expect(await page.evaluate(()=>JSON.stringify(localStorage))).not.toContain('DEMO-ONLY');
 await page.getByRole('button',{name:'Cerrar material',exact:true}).click();await expect(page.getByText('DEMO-ONLY',{exact:true})).toHaveCount(0);
});

test('renders a PDF within the catalog using the same-origin content policy',async({page})=>{
 await closureFixture(page);
 const stream='BT /F1 24 Tf 40 180 Td (Material de prueba) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 350 250] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets:number[]=[];objects.forEach((value,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${value}\nendobj\n`;});const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.map(o=>String(o).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 const errors:string[]=[];page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/v1/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/v1/assets')return route.fulfill({json:{data:[{id:'pdf-fixture',name:'Documento de demostración',kind:'file',mime_type:'application/pdf',status:'READY'}]}});
  if(path==='/v1/assets/pdf-fixture/preview')return route.fulfill({json:{data:{kind:'file',name:'Documento de demostración',mime_type:'application/pdf',content_url:'/v1/assets/pdf-fixture/content?environment=REAL&disposition=inline',download_url:'/v1/assets/pdf-fixture/content?environment=REAL&disposition=attachment'}}});
  if(path==='/v1/assets/pdf-fixture/content')return route.fulfill({contentType:'application/pdf',headers:{'Content-Disposition':'inline; filename="fixture.pdf"','Content-Security-Policy':"default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"},body:pdf});
  return route.fallback();
 });
 await page.goto('/catalog?product='+closureProduct.id+'&tab=offers');await page.getByRole('button',{name:'Ver material',exact:true}).click();
 await expect(page.getByTitle('Documento: Documento de demostración')).toBeVisible();
 await expect.poll(()=>page.frames().some(f=>f.url().includes('/v1/assets/pdf-fixture/content'))).toBe(true);
 await page.getByTitle('Documento: Documento de demostración').scrollIntoViewIfNeeded();
 await expect.poll(()=>page.frames().some(f=>f.url().startsWith('chrome-extension://'))).toBe(true);
 const viewer=page.frames().find(f=>f.url().startsWith('chrome-extension://'))!;
 await expect(viewer.locator('viewer-toolbar')).toBeVisible();
 expect(errors.filter(e=>/frame|Content Security Policy|Refused to/i.test(e))).toEqual([]);
 await page.screenshot({path:test.info().outputPath('pdf-inline.png'),fullPage:true});
});
