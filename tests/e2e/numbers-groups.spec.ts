import {evidencePath} from '../support/test-evidence-path.js';
import {test,expect} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';
import {evidencePath} from '../support/evidence.js';
const id='11111111-1111-4111-8111-111111111111';
const states=[['READY_TO_SELL','Disponible en 1 de 2 productos'],['PREPARE','Preparación automática'],['WARMING','En preparación'],['PREPARED','Preparación completada'],['DISCONNECTED','Sin conexión']];
async function expectSeparatedTargets(page:any,selector:string,minHeight=1){
 const targets=await page.locator(selector).evaluateAll((elements:any[])=>elements.filter(element=>{const style=getComputedStyle(element);return style.visibility!=='hidden'&&style.display!=='none';}).map(element=>{const box=element.getBoundingClientRect();return{label:element.textContent?.trim()||element.getAttribute('aria-label')||element.tagName,left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height};}));
 for(const target of targets){expect(target.width,target.label).toBeGreaterThan(0);expect(target.height,target.label).toBeGreaterThanOrEqual(minHeight);expect(target.left,target.label).toBeGreaterThanOrEqual(-0.5);expect(target.right,target.label).toBeLessThanOrEqual(await page.evaluate(()=>innerWidth)+0.5);}
 for(let i=0;i<targets.length;i++)for(let j=i+1;j<targets.length;j++){const a=targets[i],b=targets[j],overlapWidth=Math.min(a.right,b.right)-Math.max(a.left,b.left),overlapHeight=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);expect(overlapWidth>0&&overlapHeight>0,`${a.label} overlaps ${b.label}`).toBe(false);}
}
async function fixture(page:any){
 let empty=false,viewer=false,capacity:any={configured_limit:20,installed:3,reserved:1,in_use:1,available:1,physical_capacity_verified:null,observation:null};const writes:any[]=[];
 await page.route('**/v1/**',async(route:any)=>{const req=route.request(),path=new URL(req.url()).pathname;let data:any=[];
 const numbers=empty?[]:states.map(([primary_state,reason_text],i)=>({id:i===0?id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,version:4,alias:i===0?'Equipo Centro':'Equipo '+i,masked_number:'•••• 1234',responsible:'Responsable propio',primary_state,reason_text,connection:{state:i===4?'DISCONNECTED':'CONNECTED'},preparation:{stage:[0,3].includes(i)?'COMPLETED':i===1?'MANUAL':'GRADUAL',day:[0,3].includes(i)?15:i===1?2:7,reason:[0,3].includes(i)?'PREPARATION_COMPLETED':'AUTOMATIC_DAYS_PENDING'},observed_at:new Date().toISOString(),sales_readiness:[{assignment_id:'a',name:'Curso A',ready:i===0,checks:[]},{assignment_id:'b',name:'Curso B',ready:false,checks:[{code:'AUTHORIZATION_REQUIRED',text:'Falta permiso de envío para Curso B.'}]}],next_action:{code:'products',label:'Revisar productos'}}));
 if(req.method()!=='GET')writes.push({path,body:req.postDataJSON()});
 if(path==='/v1/me')data={user:{id:'operator',name:'Operador de ensayo',email:'fixture@example.invalid'},workspace_id:'numbers-ui-fixture',role:viewer?'viewer':'owner',permissions:viewer?['sales:read']:['*'],environment:'REAL'};
 else if(path==='/v1/numbers')data=req.method()==='GET'?numbers:{id,operation_id:'22222222-2222-4222-8222-222222222222',state:'REQUESTED'};
 else if(path==='/v1/numbers/'+id)data=numbers[0];
 else if(path.endsWith('/episodes'))data=[{id:'episode',policy_version:'standard-15d/v2',started_at:'2026-09-01T10:00:00Z'}];
 else if(path.endsWith('/preparation'))data={policy_version:'standard-15d/v2',episode:{id:'episode',version:2,policy_version:'standard-15d/v2',completed_at:'2026-09-15T10:00:00Z'},progress:{day:15,automatic_days:14,required_automatic_days:14,manual:null,reason:'PREPARATION_COMPLETED',estimated_completion_date:'2026-09-15'},declarations:[]};
 else if(path==='/v1/channel-accounts/'+id)data={id,name:'Equipo Centro',provider:'waha',status:'WORKING',device_ref:'Teléfono del equipo',version:4};
 else if(path==='/v1/number-capacity')data=capacity;
 else if(path.startsWith('/v1/number-operations/'))data={state:'HUMAN_ACTION_REQUIRED'};
 await route.fulfill({json:{data}});
 });return{writes,setEmpty(){empty=true;},setViewer(){viewer=true;},setCapacity(value:any){capacity=value;}};
}
test('an unclaimed pending command can be cancelled from setup without removing the number',async({page})=>{
 await fixture(page);let cancelled=false;const writes:any[]=[];
 await page.route(`**/v1/numbers/${id}/setup**`,async route=>{
  if(route.request().method()==='POST'){
   writes.push(route.request().postDataJSON());cancelled=true;
   await route.fulfill({json:{data:{command_id:'22222222-2222-4222-8222-222222222222',status:'CANCELLED_BEFORE_EXECUTION',remote_outcome:'NOT_ATTEMPTED'}}});return;
  }
  await route.fulfill({json:{data:{account_version:4,session_version:cancelled?10:9,status:cancelled?'REQUIRES_ATTENTION':'BLOCKED',current_step:'CONNECT',available_commands:cancelled?['connect','check_health']:['cancel_pending'],steps:[{key:'CONNECT',status:cancelled?'REQUIRES_ATTENTION':'BLOCKED',cause:cancelled?'SESSION_EVIDENCE_STALE':'CHANNEL_WORKER_STALE',source:'channel_sessions',evidence:{cancellable_command_ids:cancelled?[]:['22222222-2222-4222-8222-222222222222'],worker:cancelled?null:{ready:false,code:'CHANNEL_WORKER_STALE'}}}]}}});
 });
 await page.goto('/sales/channels/whatsapp');await page.getByRole('button',{name:'Revisar productos: Equipo Centro',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Equipo Centro',exact:true});await dialog.getByRole('button',{name:'Alta guiada',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('Servicio de conexión sin ejecución reciente');
 await dialog.getByRole('button',{name:'Cancelar orden sin iniciar',exact:true}).click();
 await expect(dialog.getByRole('button',{name:'Cancelar orden sin iniciar',exact:true})).toBeHidden();
 await expect(dialog.getByRole('button',{name:'Conectar sesión',exact:true})).toBeVisible();
 expect(writes).toHaveLength(1);expect(writes[0]).toMatchObject({action:'cancel_pending',command_id:'22222222-2222-4222-8222-222222222222',expected_version:4,expected_session_version:9,environment:'REAL'});
 await page.keyboard.press('Escape');await expect(page.getByRole('heading',{name:'Equipo Centro',exact:true})).toBeVisible();
});
test('number states, accessible drawer, focus and responsive contrast at required sizes',async({page})=>{
 await fixture(page);
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:1000});await page.goto('/sales/channels/whatsapp');await expect(page.getByRole('heading',{name:'Mis números',exact:true})).toBeVisible();
  await expect(page.getByText('Disponible en 1 de 2 productos',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await expectSeparatedTargets(page,'.page-actions button',width<=420?44:1);
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:evidencePath(`numbers-ui/inventory-${width}.png`),fullPage:true});
  const trigger=page.getByRole('button',{name:'Revisar productos: Equipo Centro',exact:true});await trigger.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Equipo Centro',exact:true});await expect(dialog).toBeVisible();
  await expectSeparatedTargets(page,'.numbers-tabs button',width<=420?44:1);
  await dialog.getByRole('button',{name:'Conexión',exact:true}).click();await expectSeparatedTargets(page,'.numbers-actions > button',width<=420?44:1);
  await dialog.getByRole('button',{name:'Preparación',exact:true}).click();await expect(dialog.getByText(/14 de 14 días automáticos/)).toBeVisible();
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:evidencePath(`numbers-ui/preparation-${width}.png`)});await page.keyboard.press('Escape');await expect(dialog).toBeHidden();await expect(trigger).toBeFocused();
 }
 await page.getByText('Apariencia',{exact:true}).click();await page.getByRole('combobox',{name:'Tema',exact:true}).selectOption('dark');await page.getByText('Apariencia',{exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.screenshot({path:evidencePath('numbers-ui/inventory-dark.png'),fullPage:true});
 await page.getByRole('button',{name:'Revisar productos: Equipo Centro',exact:true}).click();await expect(page.getByRole('dialog',{name:'Equipo Centro',exact:true})).toBeVisible();expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.screenshot({path:evidencePath('numbers-ui/detail-dark.png')});await page.keyboard.press('Escape');
 for(const zoom of [2,4]){/* Equivalent CSS viewport of 1440px at browser zoom; CSS zoom does not update media queries. */await page.setViewportSize({width:1440/zoom,height:1000/zoom});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:evidencePath(`numbers-ui/zoom-${zoom*100}.png`),fullPage:true});}
 await page.emulateMedia({reducedMotion:'reduce'});expect(await page.locator('.number-card').first().evaluate(el=>getComputedStyle(el).transitionDuration)).toBe('0s');
});
test('empty states and guided creation avoid infrastructure fields and preserve values on review',async({page})=>{
 const f=await fixture(page);f.setEmpty();await page.goto('/sales/channels/whatsapp');await expect(page.getByRole('heading',{name:'Agrega tu primer número'})).toBeVisible();
 await page.getByRole('button',{name:'Agregar número',exact:true}).click();const form=page.getByRole('dialog',{name:'Agregar número',exact:true});await form.getByLabel('Alias',{exact:true}).fill('Equipo nuevo');await form.getByLabel('Responsable',{exact:true}).fill('Operador propio');await form.getByLabel('Dispositivo principal',{exact:true}).fill('Teléfono nuevo');expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await form.getByRole('button',{name:'Preparar número'}).click();expect(f.writes.find(w=>w.path==='/v1/numbers')?.body).toMatchObject({alias:'Equipo nuevo',responsible:'Operador propio',device_ref:'Teléfono nuevo'});
 await page.goto('/sales/warmups');await expect(page.getByRole('heading',{name:'Prepara tu primer calentamiento'})).toBeVisible();await page.getByRole('button',{name:'Nuevo calentamiento'}).click();const wizard=page.getByRole('dialog',{name:'Nuevo calentamiento'});await expect(wizard.getByRole('button',{name:'Guardar y continuar'})).toBeDisabled();expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.screenshot({path:evidencePath('numbers-ui/wizard-empty.png')});
});

test('library keeps media turns editable and viewer controls stay read only',async({page})=>{
 const f=await fixture(page);let draft:any=null;
 const asset='33333333-3333-4333-8333-333333333333';
 await page.route('**/v1/assets?**',route=>route.fulfill({json:{data:[{id:asset,name:'Audio propio de prueba',kind:'file',status:'READY',mime_type:'audio/mpeg'}]}}));
 await page.route('**/v1/number-library**',async route=>{const req=route.request();if(req.method()!=='GET'){draft={id:'44444444-4444-4444-8444-444444444444',version:1,body:req.postDataJSON(),approved_content_id:null};}await route.fulfill({json:{data:req.method()==='GET'?(draft?[draft]:[]):draft}});});
 await page.goto('/sales/warmups');await page.getByRole('button',{name:'Biblioteca',exact:true}).click();const library=page.getByRole('dialog',{name:'Biblioteca de conversaciones'});
 await library.getByRole('button',{name:'Nueva conversación'}).click();await library.getByLabel('Nombre de la conversación').fill('Ensayo con audio propio');await library.getByLabel('Texto del turno 1').fill('Revisión interna acordada');await library.getByLabel('Tipo del turno 2').selectOption('audio');await library.getByLabel('Material del turno 2').selectOption(asset);await library.getByRole('checkbox').check();await library.getByRole('button',{name:'Guardar borrador',exact:true}).click();await expect(library.getByText('Audio propio',{exact:true})).toBeVisible();expect(draft.body.turns[1]).toEqual({kind:'audio',asset_id:asset});
 await library.getByRole('button',{name:'Editar conversación'}).click();await expect(library.getByLabel('Tipo del turno 2')).toHaveValue('audio');await expect(library.getByLabel('Material del turno 2')).toHaveValue(asset);await page.setViewportSize({width:390,height:844});expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.screenshot({path:evidencePath('numbers-ui/library-media-390.png')});await page.keyboard.press('Escape');
 f.setViewer();await page.reload();await expect(page.getByRole('button',{name:'Nuevo calentamiento'})).toBeDisabled();await page.getByRole('button',{name:'Biblioteca',exact:true}).click();await expect(library.getByRole('button',{name:'Nueva conversación'})).toBeDisabled();await expect(library.getByRole('button',{name:'Editar conversación'})).toBeDisabled();expect(f.writes).toEqual([]);
});
test('wizard persists three steps and separates review, authorization and activation',async({page})=>{
 const f=await fixture(page),group='55555555-5555-4555-8555-555555555555',content='66666666-6666-4666-8666-666666666666';let program:any=null;const commands:string[]=[];
 await page.route('**/v1/number-groups?**',route=>route.fulfill({json:{data:[{id:group,name:'Grupo propio observado',members:[{account_id:id},{account_id:'00000000-0000-4000-8000-000000000001'}]}]}}));
 await page.route('**/v1/number-library?**',route=>route.fulfill({json:{data:[{id:content,approved_content_id:content,body:{label:'Conversación revisada',turns:Array.from({length:6},()=>({kind:'text',text:'Prueba propia'}))}}]}}));
 await page.route('**/v1/number-programs**',async route=>{const req=route.request(),path=new URL(req.url()).pathname;let data:any=program?[program]:[];
  if(req.method()!=='GET'){const b=req.postDataJSON();if(path.endsWith('/commands')){commands.push(b.action);program={...program,version:program.version+1,status:b.action==='review'?'REVIEWED':b.action==='authorize'?'AUTHORIZED':'ACTIVE'};data={...program,ready:true,review:'a'.repeat(64),coverage:{group_sends:60,days:[]},scope:{...program.scope,max_messages:60,purpose:'preparation'},impact:[],reasons:[]};}else{program={...b,id:'77777777-7777-4777-8777-777777777777',version:(program?.version??0)+1,status:'DRAFT',scope:{expires_at:b.expires_at}};data=program;}}
  if(path.endsWith('/evidence'))data=[];await route.fulfill({json:{data}});
 });
 await page.goto('/sales/warmups');await page.getByRole('button',{name:'Nuevo calentamiento'}).click();let wizard=page.getByRole('dialog');await wizard.getByLabel('Grupo de WhatsApp').selectOption(group);await wizard.getByRole('button',{name:'Guardar y continuar'}).click();wizard=page.getByRole('dialog');await wizard.getByLabel('Conversación revisada · 6 turnos').check();await wizard.getByRole('button',{name:'Guardar y revisar'}).click();await expect(wizard.getByRole('button',{name:'Autorizar este programa'})).toBeDisabled();expect(commands).toEqual(['review']);await wizard.getByRole('checkbox').check();await wizard.getByRole('button',{name:'Autorizar este programa'}).click();await expect(wizard.getByRole('button',{name:'Activar este programa'})).toBeDisabled();expect(commands).toEqual(['review','authorize']);await wizard.getByRole('checkbox').check();await wizard.getByRole('button',{name:'Activar este programa'}).click();await expect(wizard.getByRole('status').filter({hasText:'Programa activo.'})).toBeVisible();expect(commands).toEqual(['review','authorize','activate']);expect(f.writes).toEqual([]);
});

test('guided number dialogs retain contrast and fit the dark mobile theme',async({page})=>{
 await fixture(page);await page.addInitScript(()=>localStorage.setItem('commerce-theme','dark'));await page.setViewportSize({width:390,height:844});await page.goto('/sales/channels/whatsapp');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 for(const [button,title]of [['Agregar número','Agregar número'],['Capacidad','Capacidad de números']]){
  await page.getByRole('button',{name:button,exact:true}).click();const dialog=page.getByRole('dialog',{name:title,exact:true});await expect(dialog).toBeVisible();expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.keyboard.press('Escape');
 }
 await page.goto('/sales/warmups');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 for(const [button,title,file]of [['Nuevo calentamiento','Nuevo calentamiento','wizard-dark-390'],['Biblioteca','Biblioteca de conversaciones','library-dark-390']]){
  await page.getByRole('button',{name:button,exact:true}).click();const dialog=page.getByRole('dialog',{name:title,exact:true});await expect(dialog).toBeVisible();expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.screenshot({path:evidencePath(`numbers-ui/${file}.png`)});await page.keyboard.press('Escape');
 }
});

test('capacity starts at the occupied floor instead of the logical ceiling',async({page})=>{
 const f=await fixture(page);f.setCapacity({configured_limit:20,installed:2,reserved:5,in_use:1,available:1,metrics:{logical_limit:20,provisioned_verified:2,reserved:5},slots:[{slot:1},{slot:2},{slot:4}],legacy_reservations:[{slot:3}],physical_capacity_verified:null,observation:null});
 await page.goto('/sales/channels/whatsapp');await page.getByRole('button',{name:'Capacidad',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Capacidad de números'}),input=dialog.getByLabel('Total de plazas deseadas');
 await expect(input).toHaveAttribute('min','5');await expect(input).toHaveValue('5');await input.fill('1');await expect(input).toHaveValue('5');await input.fill('6');await expect(input).toHaveValue('6');
});
