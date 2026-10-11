import {test,expect} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';

const accountId='11111111-1111-4111-8111-111111111111';
const testId='22222222-2222-4222-8222-222222222222';

test('Numbers starts and operates an isolated multi-product flow test without asking for laboratory IDs',async({page})=>{
 const writes:Array<{path:string;environment:string|null;body:any}>=[];
 const previewRequests:string[]=[];
 let awaitingContinue=false;
 const assets=[
  {id:'asset-image',kind:'image',name:'Vista del producto',mime_type:'image/png'},
  {id:'asset-audio',kind:'audio',name:'Audio de bienvenida',mime_type:'audio/mpeg'},
  {id:'asset-video',kind:'video',name:'Video de demostración',mime_type:'video/mp4'},
  {id:'asset-pdf',kind:'document',name:'Guía en PDF',mime_type:'application/pdf'},
 ];
 const routes=[
  {selection_key:'ruta-1',product_name:'Producto A',offer_name:'Oferta A',workflow_name:'Flujo A',seller_name:'Vendedor A',entry_rules:[{kind:'keyword',value:'quiero a'}]},
  {selection_key:'ruta-2',product_name:'Producto B',offer_name:'Oferta B',workflow_name:'Flujo B',seller_name:'Vendedor B',entry_rules:[{kind:'keyword',value:'quiero b'}]},
 ];
 const state=(id=testId)=>({id,status:'RUNNING',start_mode:'EMPTY',empty:false,available_actions:awaitingContinue?['continue']:['select_product','question','accept','receipt','advance','next_reminder'],virtual_now:'2026-09-20T12:00:00.000Z',assignments:routes,materials:[{name:'Acceso ficticio',kind:'access',content:'PLACEHOLDER_ONLY'}],active_route:routes[1],routing:{state:'RESOLVED',conversation_count:2},transcript:[{id:'message-1',direction:'INBOUND',kind:'text',text:'quiero b',status:'RECEIVED',at:'2026-09-20T12:00:00.000Z',dispatch_sequence:null,asset_id:null,technical:{}},...assets.map((asset,index)=>({id:`message-${index+2}`,direction:'OUTBOUND',kind:asset.kind,text:null,status:'DELIVERED',at:`2026-09-20T12:00:0${index+1}.000Z`,dispatch_sequence:index+2,asset_id:asset.id,mime_type:asset.mime_type,name:asset.name,technical:{effect_id:`effect-${asset.kind}`}}))],timers:[{id:'timer-1',kind:'followup',status:'PENDING',due_at:'2026-09-20T12:45:00.000Z',remaining_seconds:2700}],next_reminder:{timer_id:'timer-1',kind:'followup',due_at:'2026-09-20T12:45:00.000Z',seconds:2700},orders:[],receipts:[],pending_action:false,isolation:{transport:'simulator',external_network:false,real_mutation:false,bank:'LAB_PLACEHOLDER',access:'LAB_ONLY'},external_effects:false});
 await page.route('**/v1/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname,environment=url.searchParams.get('environment');
  if(request.method()!=='GET')writes.push({path,environment,body:request.postDataJSON()});
  const assetId=path.match(/^\/v1\/assets\/([^/]+)\/(preview|content)$/)?.[1],asset=assets.find(item=>item.id===assetId);
  if(asset&&path.endsWith('/content')){await route.fulfill({status:200,contentType:asset.mime_type,body:asset.kind==='image'?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'):asset.kind==='document'?Buffer.from('%PDF-1.4\n%%EOF\n'):Buffer.from([0])});return;}
  let data:any=[];
  if(path==='/v1/me')data={user:{id:'owner',name:'Operador',email:'owner@example.invalid'},workspace_id:'flow-test-ui',role:'owner',permissions:['*'],environment:'REAL'};
  else if(path==='/v1/numbers')data=[{id:accountId,version:1,alias:'Equipo Centro',masked_number:'•••• 1234',responsible:'Operador',primary_state:'READY_TO_SELL',reason_text:'Disponible para vender',connection:{state:'CONNECTED'},preparation:{stage:'COMPLETED',day:15},observed_at:'2026-09-20T11:00:00.000Z',sales_readiness:[{assignment_id:'assignment-a',name:'Producto A',ready:true,checks:[]},{assignment_id:'assignment-b',name:'Producto B',ready:true,checks:[]}],next_action:{code:'products',label:'Revisar productos'}}];
  else if(path===`/v1/channel-accounts/${accountId}/flow-tests/latest`)data=null;
  else if(path===`/v1/channel-accounts/${accountId}/flow-tests`)data=state();
  else if(asset&&path.endsWith('/preview')){previewRequests.push(request.url());data={kind:'file',name:asset.name,mime_type:asset.mime_type,content_url:`/v1/assets/${asset.id}/content?environment=SIMULATION&disposition=inline`,download_url:`/v1/assets/${asset.id}/content?environment=SIMULATION&disposition=attachment`};}
  else if(path.startsWith('/v1/number-flow-tests/')&&path.endsWith('/actions')){const type=request.postDataJSON()?.type;if(type==='select_product')awaitingContinue=true;if(type==='continue')awaitingContinue=false;data={test_id:testId,command_id:'command-fixture',external_effects:false};}
  else if(path.startsWith('/v1/number-flow-tests/')&&path.endsWith('/reset'))data=state('33333333-3333-4333-8333-333333333333');
  else if(path.startsWith('/v1/number-flow-tests/'))data=state(path.split('/').at(-1));
  await route.fulfill({status:path.endsWith('/flow-tests')&&request.method()==='POST'?201:path.endsWith('/actions')?202:200,json:{data}});
 });
 await page.route('**/api/auth/**',route=>route.fulfill({status:401,json:{error:{code:'FIXTURE_ONLY'}}}));

 await page.setViewportSize({width:390,height:900});
 await page.goto('/sales/channels/whatsapp');
 await page.getByRole('button',{name:'Probar flujo',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Probar flujo · Equipo Centro'});
 await expect(dialog).toContainText('empieza vacío');
 await expect(dialog.getByRole('textbox')).toHaveCount(0);
 await dialog.getByRole('button',{name:'Empezar chat vacío'}).click();
 await dialog.getByText('Rutas y reglas copiadas',{exact:true}).click();
 await expect(dialog.getByText('Producto A',{exact:true})).toBeVisible();
 await expect(dialog.getByText('Producto B',{exact:true})).toBeVisible();
 await expect(dialog).toContainText('SIMULATION · sin tráfico real');
 await expect(dialog).toContainText('Efectos externos: ninguno.');
 for(const asset of assets){
  const preview=dialog.locator('.asset-preview').filter({hasText:asset.name}),content=`/v1/assets/${asset.id}/content?environment=SIMULATION&disposition=inline`;
  await expect(preview).toContainText(asset.mime_type);
  await expect(preview.locator(({image:'img',audio:'audio',video:'video',document:'iframe'} as Record<string,string>)[asset.kind])).toHaveAttribute('src',content);
  await expect(preview.getByRole('link',{name:'Abrir archivo'})).toHaveAttribute('href',content);
  await expect(preview.getByRole('link',{name:'Descargar'})).toHaveAttribute('href',`/v1/assets/${asset.id}/content?environment=SIMULATION&disposition=attachment`);
 }
 await expect.poll(()=>new Set(previewRequests).size).toBe(assets.length);
 expect(previewRequests.every(value=>new URL(value).searchParams.get('environment')==='SIMULATION')).toBe(true);
 expect(await dialog.locator('input[name*="id"], input[name*="account"], input[name*="cuenta"]').count()).toBe(0);
 await dialog.getByLabel('Producto a ensayar').selectOption('ruta-2');
 await dialog.getByRole('button',{name:'Probar esta selección'}).click();
 await dialog.getByRole('button',{name:'Continuar flujo'}).click();
 await dialog.getByLabel('Escribe como cliente').fill('¿Qué incluye?');
 await dialog.getByRole('button',{name:'Enviar mensaje'}).click();
 await dialog.getByRole('button',{name:'Aceptar el acuerdo'}).click();
 await dialog.getByLabel('Monto de prueba (MXN)').fill('123.45');
 await dialog.getByRole('button',{name:'Adjuntar comprobante sintético'}).click();
 await dialog.getByLabel('Avanzar').fill('2');
 await dialog.getByLabel('Unidad').selectOption('3600');
 await dialog.getByRole('button',{name:'Avanzar tiempo'}).click();
 await dialog.getByRole('button',{name:'Ir al siguiente recordatorio'}).click();
 expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
 expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);

 expect(writes[0]).toMatchObject({path:`/v1/channel-accounts/${accountId}/flow-tests`,environment:'SIMULATION',body:{contact_name:'Contacto de prueba',start_mode:'EMPTY',environment:'SIMULATION'}});
 expect(writes.filter(write=>write.path.endsWith('/actions')).map(write=>write.body)).toEqual([
  {type:'select_product',selection_key:'ruta-2',environment:'SIMULATION'},
  {type:'continue',environment:'SIMULATION'},
  {type:'question',text:'¿Qué incluye?',environment:'SIMULATION'},
  {type:'accept',environment:'SIMULATION'},
  {type:'receipt',amount_minor:12345,currency:'MXN',environment:'SIMULATION'},
  {type:'advance',seconds:7200,environment:'SIMULATION'},
  {type:'next_reminder',environment:'SIMULATION'},
 ]);
 expect(writes.every(write=>write.environment==='SIMULATION'&&write.body.environment==='SIMULATION')).toBe(true);
});
