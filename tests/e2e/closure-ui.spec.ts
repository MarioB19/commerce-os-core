import {evidencePath} from '../support/test-evidence-path.js';
import {test,expect} from '@playwright/test';
import {closureFixture} from './support/closure-fixture.js';
import {evidencePath} from '../support/evidence.js';
test('sanitized priority screenshots before and after closure',async({page})=>{
 await closureFixture(page);
 const phase=process.env.CLOSURE_BEFORE?'before':'after';
 for(const [name,path] of [['inbox','/sales/inbox?conversation=conversation-fixture'],['numbers','/sales/channels/whatsapp'],['catalog','/catalog?product=product-fixture']]){
  await page.goto(path!);await expect(page.locator('main')).toBeVisible();await expect(page.locator('main .loading')).toHaveCount(0);await page.screenshot({path:evidencePath(`operational-closure-ui/${phase}-${name}-1440.png`),fullPage:true});
 }
});

test('normal routes ignore legacy storage and manipulated URLs, including reload',async({page})=>{
 const requests=await closureFixture(page);
 await page.addInitScript(()=>sessionStorage.setItem('commerce-environment:fixture-workspace:fixture-user','SIMULATION'));
 for(const path of ['/sales/inbox?environment=SIMULATION','/catalog?environment=SIMULATION','/sales/channels/whatsapp','/settings']){
  await page.goto(path);await expect(page.getByLabel('Contexto comercial: Operación real')).toBeVisible();await expect(page.locator('main .loading')).toHaveCount(0);
  await expect(page.getByLabel('Entorno de datos')).toHaveCount(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('commerce-environment:fixture-workspace:fixture-user'))).toBeNull();
 }
 await page.reload();await expect(page.getByLabel('Contexto comercial: Operación real')).toBeVisible();
 expect(requests.every(r=>r.environment==='REAL')).toBe(true);expect(requests.every(r=>r.method==='GET')).toBe(true);
});

test('clean session, direct lab and legacy links never activate simulation',async({page})=>{
 const requests=await closureFixture(page);
 for(const path of ['/catalog','/sales/flows/simulator','/sales/simulator','/simulator','/settings/tests?environment=SIMULATION']){
  await page.goto(path);await expect(page.getByLabel('Contexto comercial: Operación real')).toBeVisible();
  if(path!=='/catalog')await expect(page.getByRole('button',{name:'Activar laboratorio de pruebas'})).toBeVisible();
 }
 expect(requests.every(r=>r.environment==='REAL'&&r.method==='GET')).toBe(true);
});

test('explicit lab uses snapshot, local simulation commands and discards session on exit',async({page})=>{
 const requests=await closureFixture(page);
 await page.goto('/settings/tests?workflow=flow-fixture');await page.getByRole('button',{name:'Activar laboratorio de pruebas'}).click();
 await expect(page.getByLabel('Contexto local de pruebas')).toBeVisible();
 await page.getByRole('button',{name:'Crear copia de prueba'}).click();await expect(page.getByText('Copia de prueba creada.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Iniciar prueba',exact:true}).click();
 await page.getByRole('button',{name:'Simulador',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Iniciar simulación'}).click();await expect(page.getByRole('dialog')).toContainText('Comando registrado');
 await page.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
 await expect(page.locator('.command-notice')).toBeVisible();
 await page.screenshot({path:evidencePath('operational-closure-ui/after-laboratory-active-1440.png'),fullPage:true});
 const mutations=requests.filter(r=>r.method!=='GET');expect(mutations.length).toBe(3);
 expect(mutations.every(r=>r.environment==='SIMULATION'&&r.body?.environment==='SIMULATION')).toBe(true);
 expect(mutations[0]).toMatchObject({path:'/v1/simulation-snapshots',body:{workflow_version_id:'flow-fixture',expected_version:2}});
 expect(mutations[1]!.path).toBe('/v1/workflows/simulation-flow/evaluations');
 expect(mutations[2]!.body).toMatchObject({account_id:'simulation-account',offer_version_id:'simulation-offer',workflow_version_id:'simulation-flow'});
 await page.getByRole('link',{name:'Productos y ofertas',exact:true}).click();await expect(page.getByLabel('Contexto comercial: Operación real')).toBeVisible();
 await expect(page.locator('.command-notice')).toHaveCount(0);
 const boundary=requests.length;await page.getByRole('button',{name:'Nuevo producto',exact:true}).click();await page.getByLabel('Nombre del producto').fill('Borrador REAL');await page.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
 await page.waitForTimeout(1700);expect(requests.slice(boundary).every(r=>r.environment==='REAL')).toBe(true);
 await page.goto('/settings/tests');await expect(page.getByRole('button',{name:'Activar laboratorio de pruebas'})).toBeVisible();await expect(page.getByText('Copia de prueba creada.',{exact:false})).toHaveCount(0);
 expect(requests.some(r=>/waha|gateways|authorize|activate|settings\/operations/.test(r.path)&&r.method!=='GET')).toBe(false);
});

test('late snapshot response cannot reopen lab or contaminate real cache and drafts',async({page})=>{
 const requests=await closureFixture(page);let release!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve);let started=false;
 await page.route('**/v1/simulation-snapshots?environment=SIMULATION',async route=>{started=true;await waiting;await route.fulfill({json:{data:{id:'late-snapshot',workflow_version_id:'late-flow',environment:'SIMULATION'}}}).catch(()=>{});});
 await page.goto('/settings/tests?workflow=flow-fixture');await page.getByRole('button',{name:'Activar laboratorio de pruebas'}).click();await page.getByRole('button',{name:'Crear copia de prueba'}).click();await expect.poll(()=>started).toBe(true);
 await page.getByRole('link',{name:'Productos y ofertas',exact:true}).click();await page.getByRole('button',{name:'Nuevo producto',exact:true}).click();await page.getByLabel('Nombre del producto').fill('Conserva este borrador REAL');release();
 await expect(page.getByLabel('Nombre del producto')).toHaveValue('Conserva este borrador REAL');await expect(page.locator('.command-notice')).toHaveCount(0);await expect(page.getByLabel('Contexto local de pruebas')).toHaveCount(0);
 expect(requests.filter(r=>r.path.includes('late-flow'))).toEqual([]);
});

test('all screen families reflow and pass automated accessibility at requested sizes',async({page})=>{
 test.setTimeout(180000);
 const {AxeBuilder}=await import('@axe-core/playwright');
 const pageErrors:string[]=[];page.on('pageerror',error=>pageErrors.push(error.message));
 await closureFixture(page);await page.emulateMedia({reducedMotion:'reduce'});
 const priority=[['inbox','/sales/inbox?conversation=conversation-fixture'],['numbers','/sales/channels/whatsapp'],['catalog','/catalog?product=product-fixture']];
 for(const width of [1440,1024,768,360,320]){
  await page.setViewportSize({width,height:1000});
  for(const [name,path] of priority){
   await page.goto(path!);await expect(page.locator('main h1')).toBeVisible();expect(pageErrors).toEqual([]);await expect(page.getByText('Something went wrong!',{exact:true})).toHaveCount(0);await expect(page.locator('main .loading')).toHaveCount(0);
   const reflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,offenders:[...document.querySelectorAll("main *")].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right}))}));
   expect(reflow.scroll,`${name} reflow ${width}: ${JSON.stringify(reflow.offenders)}`).toBeLessThanOrEqual(width);
   const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
   expect(audit.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),`${name} axe ${width}`).toEqual([]);
   await page.screenshot({path:evidencePath(`operational-closure-ui/after-${name}-${width}.png`),fullPage:true});
  }
 }
 await page.setViewportSize({width:1440,height:1000});
 for(const [name,path] of [['home','/home'],['orders','/sales/orders'],['campaigns','/campaigns'],['flows','/sales/flows'],['flow-map','/sales/flows/flow-fixture'],['sellers','/sales/agents'],['results','/results'],['settings','/settings'],['warmup','/settings/warmup'],['meta','/settings/integrations/meta'],['mail','/settings/integrations/mail'],['security','/account/security'],['tests','/settings/tests'],['recovery','/forgot-password'],['planned','/intelligence']]){
  await page.goto(path!);await expect(page.locator('h1').first(),`${name} heading at ${path}`).toBeVisible();await expect(page.locator('main .loading')).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} reflow`).toBe(true);
  const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),`${name} axe`).toEqual([]);
  await page.screenshot({path:evidencePath(`operational-closure-ui/after-${name}-1440.png`),fullPage:true});
 }
});

test('keyboard drawer traps and restores focus, modal preserves draft on close',async({page})=>{
 await closureFixture(page);await page.setViewportSize({width:320,height:800});await page.goto('/catalog');
 await page.getByRole('button',{name:'Abrir menú',exact:true}).focus();await page.keyboard.press('Enter');const drawer=page.getByRole('dialog',{name:'Navegación de Commerce OS'});await expect(drawer).toBeVisible();
 for(let i=0;i<20;i++){await page.keyboard.press('Tab');expect(await drawer.evaluate(e=>e.contains(document.activeElement))).toBe(true);}
 await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Abrir menú',exact:true})).toBeFocused();
 const trigger=page.getByRole('button',{name:'Nuevo producto',exact:true});await trigger.focus();await page.keyboard.press('Enter');await page.getByLabel('Nombre del producto').fill('Borrador conservado');await page.keyboard.press('Escape');await expect(trigger).toBeFocused();await page.keyboard.press('Enter');await expect(page.getByLabel('Nombre del producto')).toHaveValue('Borrador conservado');
});

test('warm-up preflight conflicts preserve selected content and visible pause remains safe',async({page})=>{
 await closureFixture(page);
 await page.route('**/v1/warmup?environment=REAL',route=>route.fulfill({json:{data:{installed:true,enabled:false,pool:{id:'pool-fixture',version:3,enabled:false,paused:true},accounts:[],plans:[],jobs:[],provider_verified:false}}}));
 await page.route('**/v1/warmup/content?environment=REAL',route=>route.fulfill({json:{data:[{id:'content-fixture',body:{label:'Contenido propio'}}]}}));
 await page.route('**/v1/warmup/pools/pool-fixture/preflight?environment=REAL',route=>route.fulfill({status:409,json:{error:{code:'VERSION_CONFLICT',message:'La configuración cambió. Actualiza la revisión conservando la selección.'}}}));
 await page.goto('/settings/warmup/legacy');await expect(page.getByRole('button',{name:'Pausar warm-up',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Comprobar participantes y alcance'})).toBeDisabled();await expect(page.getByLabel(/SHA/)).toHaveCount(0);
 await page.getByLabel('Contenido propio',{exact:true}).check();await page.getByRole('button',{name:'Comprobar participantes y alcance'}).click();await expect(page.getByRole('alert')).toContainText('La configuración cambió');await expect(page.getByLabel('Contenido propio',{exact:true})).toBeChecked();
});

test('warm-up activation uses backend review, displays sales impact and requires only its concrete final click',async({page})=>{
 await closureFixture(page);const poolId='00000000-0000-4000-8000-000000000101',contentId='00000000-0000-4000-8000-000000000102',submitted:Record<string,unknown>[]=[];let preflight:Record<string,unknown>={};
 await page.route('**/v1/warmup?environment=REAL',route=>route.fulfill({json:{data:{installed:true,enabled:false,pool:{id:poolId,version:3,enabled:false,paused:true},accounts:[],plans:[],jobs:[],provider_verified:false}}}));
 await page.route('**/v1/warmup/content?environment=REAL',route=>route.fulfill({json:{data:[{id:contentId,body:{label:'Contenido sintético aprobado'}}]}}));
 await page.route(`**/v1/warmup/pools/${poolId}/preflight?environment=REAL`,route=>{preflight=route.request().postDataJSON();return route.fulfill({json:{data:{ready:true,review:'a'.repeat(64),reasons:[],capabilities:['text'],commercial_impact:'Activar restringe ventas; pausar warm-up no libera ventas.',participants:[{account_id:'own-a',alias:'Número propio A',open_conversations:2,pending_effects:1,products:[{id:'product-a',name:'Producto A'}]}]}}});});
 await page.route(`**/v1/warmup/pools/${poolId}/activate?environment=REAL`,route=>{submitted.push(route.request().postDataJSON());return route.fulfill({json:{data:{id:poolId,version:4,enabled:true}}});});
 await page.goto('/settings/warmup/legacy');await page.getByLabel('Contenido sintético aprobado',{exact:true}).check();await page.getByRole('button',{name:'Comprobar participantes y alcance'}).click();await expect(page.getByText('Activar restringe ventas; pausar warm-up no libera ventas.',{exact:true})).toBeVisible();await expect(page.getByText(/Número propio A: 2 conversaciones abiertas/)).toBeVisible();expect(submitted).toEqual([]);await expect(page.getByLabel(/SHA/)).toHaveCount(0);
 await page.getByRole('button',{name:'Activar warm-up en estos números',exact:true}).click();await expect.poll(()=>submitted.length).toBe(1);expect(submitted[0]).toEqual({...preflight,review:'a'.repeat(64),confirmation:'ACTIVATE_REVIEWED_OWN_NUMBERS'});
});

test('a real reply uses the existing server authorization and preserves a rejected draft',async({page})=>{
 await closureFixture(page);const bodies:Record<string,unknown>[]=[];
 await page.route('**/v1/conversations/conversation-fixture/commands?environment=REAL',async route=>{bodies.push(route.request().postDataJSON());await route.fulfill({status:409,json:{error:{code:'OPERATION_AUTHORIZATION_REQUIRED',message:'Se requiere una autorización vigente del número.'}}});});
 await page.goto('/sales/inbox?conversation=conversation-fixture');await expect(page.getByText('Autorización operativa para esta salida',{exact:true})).toHaveCount(0);
 await page.getByLabel('Mensaje',{exact:true}).fill('Respuesta ficticia preparada');await page.getByRole('button',{name:'Proponer mensaje',exact:true}).click();await expect(page.getByRole('alert')).toContainText('autorización vigente');await expect(page.getByLabel('Mensaje',{exact:true})).toHaveValue('Respuesta ficticia preparada');expect(bodies).toEqual([{type:'send_message',text:'Respuesta ficticia preparada',expected_version:7,environment:'REAL'}]);
});

test('unknown profile review sends only an explicit observation request and keeps uncertainty visible',async({page})=>{
 await closureFixture(page);const requests:Record<string,unknown>[]=[];
 await page.route('**/v1/warmup?environment=REAL',route=>route.fulfill({json:{data:{installed:true,enabled:false,pool:null,accounts:[{account_id:'account-fixture',version:7,status:'PROFILE_PENDING',profile_operation_status:'UNKNOWN',identity_present:true,effective_days:0}],plans:[],jobs:[],provider_verified:false}}}));
 await page.route('**/v1/warmup/accounts/account-fixture/profile-review?environment=REAL',route=>{requests.push(route.request().postDataJSON());return route.fulfill({json:{data:{account_id:'account-fixture',version:8,review_requested:true,profile_operation_status:'UNKNOWN',external_mutations:false}}});});
 await page.goto('/settings/warmup/legacy');await page.getByRole('button',{name:'Revisar perfil',exact:true}).click();const modal=page.getByRole('dialog');await expect(modal).toContainText('no vuelve a aplicar cambios');await expect(modal.getByRole('button',{name:'Solicitar lectura del perfil'})).toBeDisabled();expect(requests).toEqual([]);
 await modal.getByLabel('Motivo de revisión del perfil').fill('Comprobar estado después de timeout');await modal.getByRole('button',{name:'Solicitar lectura del perfil'}).click();await expect(modal).toBeHidden();await expect(page.getByRole('status').filter({hasText:'Revisión solicitada'})).toBeVisible();await expect(page.getByText('resultado del perfil incierto',{exact:false})).toBeVisible();expect(requests).toEqual([{expected_version:7,reason:'Comprobar estado después de timeout',environment:'REAL'}]);
});

test('identity forms share the blue system and reflow without sending credentials or mail',async({page})=>{
 const {AxeBuilder}=await import('@axe-core/playwright');const requests=await closureFixture(page);
 await page.route('**/v1/me?**',route=>route.fulfill({status:401,json:{error:{code:'UNAUTHORIZED',message:'Sesión de muestra cerrada'}}}));
 for(const width of [1440,320]){
  await page.setViewportSize({width,height:1000});
  for(const [name,path] of [['login','/login'],['recovery','/forgot-password'],['reset','/reset-password#token=synthetic-ui-only']]){
   await page.goto(path!);await expect(page.locator('input').first()).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),`${name} ${width}`).toEqual([]);await page.screenshot({path:evidencePath(`operational-closure-ui/after-${name}-${width}.png`),fullPage:true});
  }
 }
 expect(requests.every(r=>r.method==='GET')).toBe(true);
});
