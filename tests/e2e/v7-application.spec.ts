import {test,expect,type Page} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';
import {randomBytes,randomUUID} from 'node:crypto';
import {provisionUser} from '../../apps/api/src/auth.js';

// V7 F8 (RF-17, RF-16.d, RNF-05): the only web application is V7. Six main
// sections, the account menu, identity pages, the help and its download, the
// previous addresses leading to their V7 equivalent and retired functions
// saying so. Every main page is checked with axe (WCAG 2 A/AA), without
// browser errors and without horizontal overflow at 390 px.
test.use({screenshot:'off',trace:'off',video:'off'});
test.beforeEach(async({page})=>{
 // This audit reloads dozens of pages faster than a person can navigate.
 // Pace the real API requests instead of changing production rate limits or
 // retrying mutations when the whole browser suite shares one loopback IP.
 let nextRequest=0;
 await page.route(/\/(?:v1|v2|api\/auth)(?:\/|\?)/,async route=>{
  const now=Date.now(),wait=Math.max(0,nextRequest-now);nextRequest=Math.max(now,nextRequest)+300;
  if(wait)await new Promise(resolve=>setTimeout(resolve,wait));
  await route.continue();
 });
});
const profile=process.env.WORKSPACE_ID??'local';
const sections=[['Inicio','/home'],['Productos','/products'],['Ventas','/sales/inbox'],['Números','/numbers'],['Campañas','/campaigns'],['Resultados','/results']] as const;
const pages:[string,RegExp][]=[
 ['/home',/^Inicio/],['/products',/^Productos$/],['/sales/inbox',/^Conversaciones$/],['/sales/orders',/^Pedidos$/],['/sales/receipts',/^Comprobantes$/],['/sales/payments',/^Pagos$/],
 ['/numbers',/^Números$/],['/campaigns',/^Campañas$/],['/results',/^Resultados$/],['/help',/^Ayuda$/],['/account/integrations',/^Integraciones$/],['/account/security',/^Seguridad$/],
];
async function owner(){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({email,password,name:'Dueña de prueba',workspace_id:profile,role:'owner'});
 return{email,password};
}
async function signIn(page:Page,account:{email:string;password:string}){
 await page.goto('/login');
 await page.getByLabel('Correo electrónico').fill(account.email);await page.getByLabel('Contraseña',{exact:true}).fill(account.password);
 await page.getByRole('button',{name:'Entrar a Commerce OS'}).click();
 const chooser=page.getByRole('heading',{name:'Tus perfiles'});
 await expect(page.getByRole('navigation',{name:'Navegación del perfil'}).or(chooser)).toBeVisible();
 if(await chooser.isVisible()){await page.getByLabel('Perfil',{exact:true}).selectOption(profile);await page.getByRole('button',{name:'Cambiar a este perfil'}).click();}
 await expect(page.getByRole('navigation',{name:'Navegación del perfil'})).toBeVisible();
}
async function axe(page:Page,label:string){
 const r=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
 expect(r.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)})),label).toEqual([]);
}
// provisionUser uses the shared database pool of the Playwright worker; the
// worker process ends it on exit (ending it here broke the files that run later).

test('six sections, account menu and every main page: accessible, without errors or overflow',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await signIn(page,await owner());
 const nav=page.getByRole('navigation',{name:'Navegación del perfil'});
 await expect(nav.getByRole('link')).toHaveCount(6);
 for(const [label,href] of sections)await expect(nav.getByRole('link',{name:label,exact:true})).toHaveAttribute('href',href);
 await page.getByText(/^Mi cuenta/).click();
 const menu=page.getByRole('navigation',{name:'Mi cuenta'});
 for(const label of ['Seguridad','Perfil del negocio','Integraciones','Empleados e invitaciones','Accesos MCP','Ayuda'])await expect(menu.getByRole('link',{name:label,exact:true})).toBeVisible();
 for(const [path,heading] of pages){
  await page.goto(path);
  await expect(page.getByRole('heading',{level:1,name:heading})).toBeVisible();
  await page.waitForLoadState('networkidle');
  await axe(page,path);
 }
 for(const path of ['/settings/profile','/settings/employees','/account/tokens']){await page.goto(path);await expect(page.locator('main h2').first()).toBeVisible();await axe(page,path);}
 await page.setViewportSize({width:390,height:844});
 for(const [path,heading] of pages){
  await page.goto(path);await expect(page.getByRole('heading',{level:1,name:heading})).toBeVisible();await page.waitForLoadState('networkidle');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth),path+' at 390 px').toBeLessThanOrEqual(1);
 }
 expect(errors).toEqual([]);
});

// RF-17.k (UX-A11Y) and RF-17.b (UX-PRIMARY): keyboard only, targets of at
// least 44 px and, per page, at most one primary action in view on arrival.
test('keyboard reaches every section, targets are 44 px and one primary action per page',async({page})=>{
 await signIn(page,await owner());
 await page.goto('/home');await expect(page.getByRole('heading',{level:1,name:/^Inicio/})).toBeVisible();
 // The application moves focus to <main> on each route; from the top of the
 // document the first stop is the skip link.
 await page.evaluate(()=>{const b=document.body;b.tabIndex=-1;b.focus();b.removeAttribute('tabindex');});
 await page.keyboard.press('Tab');
 await expect(page.getByRole('link',{name:'Saltar al contenido'})).toBeFocused();
 await page.keyboard.press('Enter');
 await expect(page.locator('#profile-main')).toBeFocused();
 for(const [label,href] of sections){
  await page.goto('/home');await expect(page.getByRole('heading',{level:1,name:/^Inicio/})).toBeVisible();
  await page.evaluate(()=>{const b=document.body;b.tabIndex=-1;b.focus();b.removeAttribute('tabindex');});
  const link=page.getByRole('navigation',{name:'Navegación del perfil'}).getByRole('link',{name:label,exact:true});
  let reached=false;
  for(let i=0;i<40&&!reached;i++){await page.keyboard.press('Tab');reached=await link.evaluate(e=>e===document.activeElement);}
  expect(reached,label+' by keyboard').toBe(true);
  await page.keyboard.press('Enter');await expect(page).toHaveURL(new RegExp(href.replace(/\//g,'\\/')+'(?:\\?.*)?$'));
 }
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:width===390?844:1050});
  for(const [path,heading] of pages){
   await page.goto(path);await expect(page.getByRole('heading',{level:1,name:heading})).toBeVisible();
   const small=await page.evaluate(()=>[...document.querySelectorAll('main button,main summary,main a[data-variant],main input:not([type=checkbox]):not([type=radio]):not([type=hidden]),main select,main textarea,nav a,header button')]
    .filter(e=>{const r=e.getBoundingClientRect(),st=getComputedStyle(e);return r.width>0&&r.height>0&&st.visibility!=='hidden';})
    .filter(e=>e.getBoundingClientRect().height<43.5).map(e=>(e.tagName+':'+(e.textContent??'').trim()).slice(0,60)));
   expect(small,path+' targets at '+width+' px').toEqual([]);
   const primary=await page.evaluate(()=>[...document.querySelectorAll('main [data-variant="default"]')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.top<window.innerHeight;}).map(e=>(e.textContent??'').trim()));
   expect(primary.length,path+' primary actions in view at '+width+' px: '+primary.join(' | ')).toBeLessThanOrEqual(1);
  }
 }
});

test('previous addresses lead to V7 and retired functions say so without data',async({page})=>{
 await signIn(page,await owner());
 for(const [from,to] of [['/catalog','/products'],['/sales','/sales/inbox'],['/sales/channels/whatsapp','/numbers'],['/settings/integrations','/account/integrations'],['/help/launch','/help'],['/settings/tests','/numbers']] as const){
  await page.goto(from);await expect(page).toHaveURL(new RegExp(to.replace(/\//g,'\\/')+'$'));
 }
 for(const path of ['/intelligence','/studio','/archive/materials','/settings/creative']){
  await page.goto(path);await expect(page.getByRole('heading',{name:'Esta función se retiró'})).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Navegación del perfil'})).toHaveCount(0);
 }
 await page.goto('/no-existe');await expect(page.getByRole('heading',{name:'Esta página no existe'})).toBeVisible();
});

test('help is published and downloadable; the MCP connector is served',async({page})=>{
 await signIn(page,await owner());
 await page.goto('/help');
 await page.getByRole('link',{name:'Operar con IA (Claude o Codex)'}).click();
 await expect(page.getByText('COMMERCE_MCP_TOKEN_FILE').first()).toBeVisible();
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Descargar guía'}).click();const download=await pending;
 expect(download.suggestedFilename()).toMatch(/^ayuda-commerce-os-\d{4}-\d{2}-\d{2}\.md$/);
 const text=await new Promise<string>((resolve,reject)=>{download.createReadStream().then(stream=>{const parts:Buffer[]=[];stream.on('data',c=>parts.push(Buffer.from(c)));stream.on('end',()=>resolve(Buffer.concat(parts).toString('utf8')));stream.on('error',reject);},reject);});
 expect(text).toContain('# Ayuda de Commerce OS');expect(text).toContain('Empieza a vender en 6 pasos');
 const connector=await page.request.get('/downloads/commerce-os-mcp.mjs');
 expect(connector.status()).toBe(200);expect((await connector.body()).length).toBeGreaterThan(10_000);
});

test('identity pages work without a selected profile; an invitation link without its token is refused',async({page})=>{
 await page.goto('/accept-invitation');await expect(page.getByRole('alert')).toContainText('El enlace no es válido');
 await page.goto('/forgot-password');await expect(page.getByRole('heading',{name:'Recupera tu acceso'})).toBeVisible();await axe(page,'/forgot-password');
 await page.goto('/login');await expect(page.getByRole('heading',{name:'Bienvenido de nuevo'})).toBeVisible();await axe(page,'/login');
 await page.getByRole('link',{name:'Olvidé mi contraseña'}).click();await expect(page).toHaveURL(/\/forgot-password$/);
});

test('V7.2 group warmup: review, start, library preview and accessible mobile controls',async({page})=>{
 const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const numbers=[2,3].map(n=>({id:id(n),label:'Línea interna '+n,connected:true,status:'AWAITING_PEER',reason:'GROUP_SELECTION_REQUIRED',group_required:true,effective_days:0}));
 const group={id:id(1),name:'Equipo interno',version:1,members:numbers.map(n=>({accountId:n.id,resolved:true,admin:true})),eligible:true,reason:null};
 const library={version:'operacion-interna-es/v1',name:'Coordinación y revisión de materiales',manifest:{scripts:500,messages:5000,topics:['Alcance']}};
 let started=false,config:any;const commands:any[]=[];
 await page.route('**/v2/warmup**',async route=>{
  const request=route.request(),url=new URL(request.url()),body=request.method()==='POST'?request.postDataJSON():undefined;
  let data:any;
  if(url.pathname==='/v2/warmup')data={programs:started?[{id:id(4),name:config.name,version:2,status:'ACTIVE',config,numbers:numbers.map(n=>({...n,reason:'GROUP_PLANNED',group_required:false})),history:[]}]:[],numbers,ai:false};
  else if(url.pathname==='/v2/warmup/groups')data=[group];
  else if(url.pathname==='/v2/warmup/libraries')data=[library];
  else if(url.pathname==='/v2/warmup/library')data={version:library.version,total:1,nextOffset:null,scripts:[{label:'Alcance: guía de bienvenida',topic:'Alcance',ownership_confirmed:true,turns:[{kind:'text',text:'Propongo revisar las instrucciones antes de compartir el material.'},{kind:'text',text:'Podemos empezar por identificar los pasos que necesitan un ejemplo.'}]}]};
  else if(url.pathname==='/v2/warmup/preview')data={ready:true,previewHash:'a'.repeat(64),members:numbers.map(n=>n.id),groupName:group.name,blockers:[],coverage:{uniqueMessages:5000,requiredMessages:1680,maximumDaily:200,sufficient:true},outgoingBudget:{total:30,per_sender:15},transition:[]};
  else if(url.pathname==='/v2/warmup/programs'){config=body.config;data={id:id(4),version:1,status:'DRAFT'};}
  else if(url.pathname===`/v2/warmup/programs/${id(4)}/commands`){commands.push(body);started=true;data={id:id(4),version:2,status:'ACTIVE'};}
  else throw Error('Unexpected warmup route '+url.pathname);
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
 });
 await signIn(page,await owner());await page.goto('/numbers');await page.getByRole('button',{name:'Calentamientos',exact:true}).click();
 await expect(page.getByRole('heading',{level:1,name:'Calentamientos'})).toBeVisible();await page.getByRole('button',{name:'Nuevo calentamiento'}).click();
 await page.getByLabel('Grupo existente').selectOption(id(1));await page.getByRole('button',{name:'Revisar',exact:true}).click();
 await expect(page.getByText('Revisión antes de iniciar',{exact:true})).toBeVisible();await axe(page,'group warmup review');
 await page.getByRole('button',{name:'Guardar e iniciar'}).click();await expect(page.getByText('Activo',{exact:true})).toBeVisible();
 expect(commands).toHaveLength(1);expect(commands[0]).toMatchObject({action:'start',expectedVersion:1,previewHash:'a'.repeat(64)});expect(config.senderIds).toEqual(numbers.map(n=>n.id));
 await page.setViewportSize({width:390,height:844});await axe(page,'group warmup mobile');expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(1);
 await page.getByRole('button',{name:'Ver biblioteca',exact:true}).click();await page.getByText('Alcance: guía de bienvenida',{exact:true}).click();await expect(page.getByText('Propongo revisar las instrucciones antes de compartir el material.',{exact:true})).toBeVisible();await axe(page,'static library browser');
});

// V7.4 — Números y calentamiento sin fricción. The web application runs for
// real; the number and warm-up API answers are fixtures, so no gateway, QR
// session or message is involved.
const v74=(n:number)=>`00000000-0000-4000-8000-${String(7400+n).padStart(12,'0')}`;
const numberRow=(n:number,over:Record<string,unknown>={})=>({id:v74(n),version:3,alias:'Inovaris prueba '+n,masked_number:'•••• 000'+n,state:'CONNECTED',label:'Conectado',qr_available:false,next_action:{code:'view',label:'Ver número'},confirmed_at:new Date().toISOString(),
 detail:null,preparation:null,warmup_mode:'REQUIRED',status:{code:'WARMUP_PENDING',label:'Conectado · calentamiento por configurar'},products:[],last_test:null,
 warmup:{mode:'REQUIRED',state:'GROUP_REQUIRED',label:'Elige un grupo para empezar',effective_days:0,target_days:14,program:null},...over});
const json=(route:any,data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(status>=400?{error:data}:{data})});

test('V7.4 números: elegir calentamiento al registrar, preparación veraz con reintento y estados separados',async({page})=>{
 const created:any[]=[],links:any[]=[],modes:any[]=[];let phase:'PREPARING'|'PREPARATION_DELAYED'|'PREPARATION_FAILED'|'WAITING_SCAN'|'CONNECTED'='PREPARING',numbers:any[]=[
  numberRow(1),
  numberRow(2,{warmup_mode:'DECLARED_READY',status:{code:'READY_TO_ASSIGN',label:'Listo para asignar'},warmup:{mode:'DECLARED_READY',state:'NOT_REQUESTED',label:'Ya preparado: sin calentamiento automático',effective_days:0,target_days:14,program:null}}),
  numberRow(3,{status:{code:'WARMING',label:'Calentando'},warmup:{mode:'REQUIRED',state:'ACTIVE',label:'Calentamiento activo · 3 de 14 días efectivos',effective_days:3,target_days:14,program:{id:v74(90),name:'Equipo',status:'ACTIVE',role:'sender'}}})];
 const linkView=()=>({id:v74(9),version:1,alias:'Línea nueva',masked_number:'•••• 4321',state:phase,label:phase,qr_available:phase==='WAITING_SCAN',next_action:phase==='PREPARATION_FAILED'?{code:'retry_preparation',label:'Reintentar la preparación'}:null,confirmed_at:null,warmup_mode:created[0]?.warmup==='ready'?'DECLARED_READY':'REQUIRED',
  detail:phase==='PREPARING'?'Estamos preparando la conexión de este número. Suele tardar entre uno y cinco minutos; el QR aparece aquí en cuanto esté lista.':phase==='PREPARATION_DELAYED'?'La preparación está tardando más de lo normal. Seguimos intentándolo automáticamente y tu número está guardado: no necesitas registrarlo otra vez. Puedes cerrar esta ventana y volver después.':phase==='PREPARATION_FAILED'?'No pudimos preparar la conexión de este número. Tu número está guardado; puedes reintentar la preparación sin registrarlo otra vez.':null,
  preparation:phase.startsWith('PREPAR')?{since:new Date().toISOString(),expected_seconds:300,automatic_retry:phase!=='PREPARATION_FAILED',retryable:phase==='PREPARATION_FAILED'}:null});
 await page.route('**/v1/numbers/**',async route=>{
  const request=route.request(),url=new URL(request.url()),body=request.method()==='POST'?request.postDataJSON():undefined;
  if(url.pathname==='/v1/numbers/overview')return json(route,{numbers,limit:10});
  if(url.pathname==='/v1/numbers/quick'){created.push({...body,key:request.headers()['idempotency-key']});return json(route,{id:v74(9),version:1,state:'PREPARING',label:'Preparando el número',warmup_mode:body.warmup==='ready'?'DECLARED_READY':'REQUIRED'},202);}
  if(url.pathname===`/v1/numbers/${v74(9)}/link`){if(request.method()==='POST'){links.push(body);if(body.action==='retry_preparation')phase='PREPARING';}return json(route,linkView());}
  if(url.pathname.endsWith('/warmup')){modes.push({id:url.pathname.split('/')[3],...body});numbers=numbers.map(n=>n.id===url.pathname.split('/')[3]?numberRow(1,{warmup_mode:'DECLARED_READY',status:{code:'READY_TO_ASSIGN',label:'Listo para asignar'},warmup:{mode:'DECLARED_READY',state:'NOT_REQUESTED',label:'Ya preparado: sin calentamiento automático',effective_days:0,target_days:14,program:null}}):n);return json(route,{id:v74(1),version:4,warmup_mode:'DECLARED_READY',changed:true,cancelled_unsent:0,programs_paused:0,deliveries_to_confirm:0});}
  return route.continue();
 });
 await page.route(`**/v1/channel-accounts/${v74(9)}/qr**`,route=>json(route,{mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',expiresAt:new Date(Date.now()+15000).toISOString()}));
 await signIn(page,await owner());await page.goto('/numbers');
 // Connection, warm-up choice and real progress are shown separately.
 const cards=page.getByRole('list',{name:'Tus números'});
 await expect(cards.getByText('Elige un grupo para empezar')).toBeVisible();await expect(cards.getByText('Ya preparado: sin calentamiento automático')).toBeVisible();
 await expect(cards.getByText('Calentamiento activo · 3 de 14 días efectivos')).toBeVisible();await expect(cards.getByRole('progressbar')).toHaveCount(1);
 await expect(page.getByText(/día \d+ de 15/)).toHaveCount(0);await expect(cards.getByText('Calentando',{exact:true})).toHaveCount(1);
 await axe(page,'numbers with warm-up states');
 // Registering asks for the choice; nothing is preselected and it cannot be skipped.
 await page.getByRole('button',{name:'Agregar número'}).click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('Alias').fill('Línea nueva');
 await expect(dialog.getByRole('radio',{name:/Necesita calentamiento/})).not.toBeChecked();await expect(dialog.getByRole('radio',{name:/Ya está preparado/})).not.toBeChecked();
 await expect(dialog.getByRole('button',{name:'Continuar al QR'})).toBeDisabled();await axe(page,'add number with warm-up choice');
 await dialog.getByRole('radio',{name:/Ya está preparado; no iniciar calentamiento/}).check();
 await dialog.getByRole('button',{name:'Continuar al QR'}).dblclick();
 // The double click registers one number.
 await expect(page.getByRole('dialog').getByText(/Suele tardar entre uno y cinco minutos/)).toBeVisible();
 expect(created).toHaveLength(1);expect(created[0]).toMatchObject({alias:'Línea nueva',country:'MX',warmup:'ready'});
 await expect(page.getByText(/unos segundos/)).toHaveCount(0);
 // Late: the operator is told, with what happens next; no endless spinner.
 phase='PREPARATION_DELAYED';await expect(page.getByRole('dialog').getByText(/Seguimos intentándolo automáticamente/)).toBeVisible();
 // Failed: a safe retry of the same preparation.
 phase='PREPARATION_FAILED';await expect(page.getByRole('dialog').getByText(/puedes reintentar la preparación sin registrarlo otra vez/)).toBeVisible();await axe(page,'number preparation failed');
 await page.getByRole('dialog').getByRole('button',{name:'Reintentar la preparación'}).click();
 await expect(page.getByRole('dialog').getByText(/Suele tardar entre uno y cinco minutos/)).toBeVisible();expect(links.filter(l=>l.action==='retry_preparation')).toHaveLength(1);
 // The QR appears by itself, and after connecting the text follows the choice.
 phase='WAITING_SCAN';await expect(page.getByRole('img',{name:'QR temporal para vincular tu teléfono'})).toBeVisible();
 phase='CONNECTED';await expect(page.getByRole('dialog').getByText(/Marcaste este número como ya preparado: no se programará ningún calentamiento/)).toBeVisible();
 await expect(page.getByText('El calentamiento y las comprobaciones empiezan automáticamente.')).toHaveCount(0);
 // Closing and reopening does not start anything again.
 await page.getByRole('dialog').getByRole('button',{name:'Ver número'}).click();expect(links.filter(l=>l.action==='link')).toHaveLength(0);
 // The choice of an existing number is visible and editable, saying what it does.
 await page.getByRole('button',{name:'Cambiar el calentamiento de Inovaris prueba 1'}).click();
 const choice=page.getByRole('dialog');await expect(choice.getByRole('radio',{name:/Necesita calentamiento/})).toBeChecked();await expect(choice.getByRole('button',{name:'Guardar elección'})).toBeDisabled();
 await choice.getByRole('radio',{name:/Ya está preparado/}).check();await axe(page,'change warm-up choice');await choice.getByRole('button',{name:'Guardar elección'}).click();
 await expect(choice.getByText(/queda como ya preparado/)).toBeVisible();expect(modes).toEqual([{id:v74(1),mode:'ready',expected_version:3}]);
 await page.setViewportSize({width:390,height:844});await choice.getByRole('button',{name:'Cerrar'}).first().click();
 await axe(page,'numbers mobile');expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(1);
});

test('V7.4 calentamientos: consulta con causa distinguible, grupo mixto con externos y confirmación de audiencia',async({page})=>{
 const lines=[1,2,3].map(n=>({id:v74(n),label:'•••• 000'+n,alias:'Inovaris WA '+n,connected:true,status:'AWAITING_PEER',reason:'GROUP_SELECTION_REQUIRED',group_required:true,effective_days:0,warmup_mode:'REQUIRED',line:'READY'}));
 const pending={id:v74(4),label:'•••• 0004',alias:'Inovaris WA 4',connected:true,status:null,reason:null,group_required:null,effective_days:null,warmup_mode:'REQUIRED',line:'VERIFICATION_PENDING'};
 const group={id:v74(20),name:'Grupo Calientito de prueba',version:4,eligible:true,reason:null,audience:{participants:3,ownReady:0,external:2,total:5},
  members:[...lines.map(n=>({accountId:n.id,resolved:true,admin:false,kind:'own'})),{accountId:null,resolved:false,admin:false,kind:'external'},{accountId:null,resolved:false,admin:true,kind:'external'}]};
 const library={version:'operacion-interna-es/v1',name:'Coordinación y revisión de materiales',manifest:{scripts:500,messages:5000,topics:['Alcance']}};
 let groups:any[]=[],refresh:any=null,outcome:'incompatible'|'unavailable'|'ok'='incompatible',started=false,config:any;const refreshes:any[]=[],commands:any[]=[];
 await page.route('**/v2/warmup**',async route=>{
  const request=route.request(),url=new URL(request.url()),body=request.method()==='POST'?request.postDataJSON():undefined;
  if(url.pathname==='/v2/warmup')return json(route,{programs:started?[{id:v74(40),name:config.name,version:2,status:'ACTIVE',config,audience:{external:2,ownReady:0,total:5},numbers:lines.map(n=>({...n,reason:'GROUP_PLANNED',group_required:false})),history:[]}]:[],numbers:[...lines,pending],refresh,ai:false});
  if(url.pathname==='/v2/warmup/groups')return json(route,groups);
  if(url.pathname==='/v2/warmup/libraries')return json(route,[library]);
  if(url.pathname==='/v2/warmup/groups/refresh'){refreshes.push(body);return json(route,{id:body.operationId,state:'REQUESTED',joined:false,lines:[]});}
  if(url.pathname.startsWith('/v2/warmup/operations/')){const id=url.pathname.split('/').pop()!;
   if(outcome==='incompatible'){refresh={id,state:'FAILED',reason:'GROUP_LIST_RESPONSE_UNSUPPORTED',accounts:Object.fromEntries(lines.map(n=>[n.id,{state:'FAILED',groups:0,reason:'GROUP_LIST_RESPONSE_UNSUPPORTED'}])),updated_at:new Date().toISOString()};return json(route,{id,state:'FAILED',result:{reason:'GROUP_LIST_RESPONSE_UNSUPPORTED'}});}
   if(outcome==='unavailable'){refresh={id,state:'SUCCEEDED',reason:null,accounts:{[v74(1)]:{state:'READ',groups:1},[v74(2)]:{state:'FAILED',groups:0,reason:'GROUP_PROVIDER_UNAVAILABLE'},[v74(3)]:{state:'READ',groups:1}},updated_at:new Date().toISOString()};groups=[group];return json(route,{id,state:'SUCCEEDED',result:{summary:{groups:1,lines_read:2,lines_failed:1}}});}
   refresh={id,state:'SUCCEEDED',reason:null,accounts:Object.fromEntries(lines.map(n=>[n.id,{state:'READ',groups:1}])),updated_at:new Date().toISOString()};groups=[group];return json(route,{id,state:'SUCCEEDED',result:{summary:{groups:1,lines_read:3,lines_failed:0}}});}
  if(url.pathname==='/v2/warmup/preview')return json(route,{ready:true,previewHash:'b'.repeat(64),members:lines.map(n=>n.id),groupName:group.name,blockers:[],audience:{participants:3,senders:body.config.senderIds.length,receiveOnly:3-body.config.senderIds.length,ownReady:0,external:2,total:5,consentRequired:true},coverage:{uniqueMessages:5000,requiredMessages:1680,maximumDaily:200,sufficient:true},outgoingBudget:{total:30,per_sender:10},transition:[]});
  if(url.pathname==='/v2/warmup/programs'){config=body.config;return json(route,{id:v74(40),version:1,status:'DRAFT'});}
  if(url.pathname===`/v2/warmup/programs/${v74(40)}/commands`){commands.push(body);started=true;return json(route,{id:v74(40),version:2,status:'ACTIVE'});}
  throw Error('Unexpected warmup route '+url.pathname);
 });
 await signIn(page,await owner());await page.goto('/numbers');await page.getByRole('button',{name:'Calentamientos',exact:true}).click();
 // A line whose confirmation is in flight is a wait, not «conecta por QR».
 await expect(page.getByText(/Inovaris WA 4: conexión recibida; estamos terminando de comprobarla. No necesitas escanear de nuevo/)).toBeVisible();
 // 1. The provider answers in a format we cannot read: said as such.
 await page.getByRole('button',{name:'Actualizar grupos'}).first().click();
 await expect(page.getByText(/WhatsApp respondió con un formato que no reconocemos/).first()).toBeVisible();
 await expect(page.getByText(/Conecta por QR todas las líneas del grupo/)).toHaveCount(0);
 // Only the lines that can answer now are consulted; the pending one is not.
 expect(refreshes[0].accountIds).toEqual(lines.map(n=>n.id));await axe(page,'group read failed');
 // 2. One gateway unreachable: the other lines' result is kept and the cause is named per line.
 outcome='unavailable';await page.getByRole('button',{name:'Actualizar grupos'}).first().click();
 await expect(page.getByText('Consulta terminada: 1 grupo encontrado.')).toBeVisible();await expect(page.getByText(/Inovaris WA 2:/)).toBeVisible();await expect(page.getByText(/No pudimos comunicarnos con el servicio de WhatsApp de la línea/)).toBeVisible();
 // 3. Mixed group: three own senders and two externals without account or QR.
 outcome='ok';await page.getByRole('button',{name:'Actualizar grupos'}).first().click();await expect(page.getByText(/Inovaris WA 2:/)).toHaveCount(0);
 await page.getByRole('button',{name:'Nuevo calentamiento'}).click();
 const editor=page.getByRole('dialog');await editor.getByLabel('Grupo existente').selectOption(v74(20));
 await expect(editor.getByText(/2 participantes externos \(sin cuenta en Commerce OS\): sólo reciben en el grupo/)).toBeVisible();
 for(const n of lines)await expect(editor.getByRole('checkbox',{name:n.alias})).toBeChecked();
 await editor.getByRole('button',{name:'Revisar',exact:true}).click();
 await expect(editor.getByText('Revisión antes de iniciar',{exact:true})).toBeVisible();
 await expect(editor.getByText('Inovaris WA 1, Inovaris WA 2, Inovaris WA 3',{exact:true})).toBeVisible();await expect(editor.getByText('2 participantes externos',{exact:true})).toBeVisible();
 await expect(editor.getByText(/hasta 30 mensajes al día en el grupo y 10 por línea que envía/)).toBeVisible();
 // Starting needs the owner's explicit confirmation about the externals.
 const start=editor.getByRole('button',{name:'Guardar e iniciar'});await expect(start).toBeDisabled();await axe(page,'mixed group review');
 await editor.getByRole('checkbox',{name:/Confirmo que los 2 participantes externos de este grupo aceptan recibir estos mensajes/}).check();
 await start.click();await expect(page.getByText('Activo',{exact:true})).toBeVisible();
 expect(commands).toHaveLength(1);expect(commands[0]).toMatchObject({action:'start',expectedVersion:1,previewHash:'b'.repeat(64),audienceConfirmed:true});expect(config.senderIds).toEqual(lines.map(n=>n.id));
 await expect(page.getByText(/2 participantes externos que sólo reciben/)).toBeVisible();
 // Changing who sends invalidates the confirmation (review again).
 await page.setViewportSize({width:390,height:844});await axe(page,'mixed group program mobile');expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(1);
});

// V7.5 §2/§3/§5 (H02, H03, H09) in the mounted application with routed API answers.
test('V7.5 calentamientos: protección visible, revisión y recuperación; el editor guarda una edición posterior a un fallo',async({page})=>{
 const v75=(n:number)=>`00000000-0000-4000-8075-${String(n).padStart(12,'0')}`;
 const lines=[1,2,3].map(n=>({id:v75(n),label:'•••• 750'+n,alias:'Inovaris WA '+(n+3),connected:true,status:'WARMING',reason:'PROTECTION_OPEN',group_required:false,effective_days:0,warmup_mode:'REQUIRED',line:'READY'}));
 const group={id:v75(20),name:'Grupo Calientito 2',version:1,eligible:true,reason:null,audience:{participants:3,ownReady:0,external:2,total:5},
  members:[...lines.map(n=>({accountId:n.id,resolved:true,admin:false,kind:'own'})),{accountId:null,resolved:false,admin:false,kind:'external'},{accountId:null,resolved:false,admin:false,kind:'external'}]};
 const library={version:'operacion-interna-es/v1',name:'Coordinación',manifest:{scripts:500,messages:5000,topics:['Alcance']}};
 let config:any={name:'Calentamiento Inovaris WA 4–6',groupId:group.id,senderIds:lines.map(n=>n.id),libraryVersion:library.version,timezone:'America/Mexico_City',startHour:9,endHour:18,groupDailyLimit:300,senderDailyLimit:100,maintenance:false};
 let version=2,status='ACTIVE',protection:any={open:true,reason:'DISTINCT_ACCOUNT_FAILURE_THRESHOLD',openedAt:'2026-11-12T01:07:14.000Z',reviewedUntil:null},failResume=true;
 const commands:any[]=[],previews:any[]=[];
 const program=()=>({id:v75(40),name:config.name,version,status,config,audience:{external:2,ownReady:0,total:5},numbers:lines,history:[],protection,
  effective:protection.open?{state:'PROTECTED',reasons:['DISTINCT_ACCOUNT_FAILURE_THRESHOLD'],observedAt:new Date().toISOString(),nextAction:'REVIEW_AND_RECOVER_PROTECTION',nextSend:null}
   :status==='PAUSED'?{state:'PAUSED_BY_HUMAN',reasons:[],observedAt:new Date().toISOString(),nextAction:'REVIEW_AND_RESUME',nextSend:null}:{state:'WAITING_WINDOW',reasons:['QUIET_HOURS'],observedAt:new Date().toISOString(),nextAction:null,nextSend:null}});
 await page.route('**/v2/warmup**',async route=>{
  const request=route.request(),url=new URL(request.url()),body=request.method()==='POST'?request.postDataJSON():undefined;
  if(url.pathname==='/v2/warmup')return json(route,{programs:[program()],numbers:lines,refresh:null,ai:false});
  if(url.pathname===`/v2/warmup/programs/${v75(40)}`)return json(route,program());
  if(url.pathname==='/v2/warmup/groups')return json(route,[group]);
  if(url.pathname==='/v2/warmup/libraries')return json(route,[library]);
  if(url.pathname===`/v2/warmup/programs/${v75(40)}/recovery-preview`)return json(route,{programVersion:version,programStatus:status,protection,failures:[{accountId:v75(2),kind:'FAILED',observedAt:'2026-11-12T01:14:21.000Z',source:'health'}],
   lines:lines.map(n=>({accountId:n.id,health:'CURRENT',identity:'VERIFIED',ownership:'OPERATIONAL',freezeReason:null,restricted:false,paused:false})),blockers:[],ready:true,recoveryHash:'d'.repeat(64)});
  if(url.pathname==='/v2/warmup/preview'){previews.push(body);return json(route,{ready:true,previewHash:(previews.length%2?'e':'f').repeat(64),members:lines.map(n=>n.id),groupName:group.name,blockers:[],audience:{participants:3,senders:3,receiveOnly:0,ownReady:0,external:2,total:5,consentRequired:true},coverage:{uniqueMessages:5000,requiredMessages:1680,maximumDaily:200,sufficient:true},outgoingBudget:{total:45,per_sender:15},transition:[]});}
  if(url.pathname===`/v2/warmup/programs/${v75(40)}/commands`){commands.push(body);
   if(body.expectedVersion!==version)return json(route,{code:'WARMUP_VERSION_CONFLICT',message:'conflict'},409);
   if(body.action==='recover'){protection={...protection,open:false,reviewedUntil:new Date().toISOString()};version++;return json(route,{id:v75(40),version,status});}
   if(body.action==='pause'){status='PAUSED';version++;return json(route,{id:v75(40),version,status});}
   if(body.action==='configure'){config=body.config;version++;return json(route,{id:v75(40),version,status:'PAUSED'});}
   if(body.action==='resume'){if(failResume){failResume=false;return json(route,{code:'MEMBER_HEALTH_STALE',message:'stale'},409);}status='ACTIVE';version++;return json(route,{id:v75(40),version,status});}
  }
  throw Error('Unexpected warmup route '+url.pathname);
 });
 await signIn(page,await owner());await page.goto('/numbers');await page.getByRole('button',{name:'Calentamientos',exact:true}).click();
 // H03: an ACTIVE program whose protection is open never reads «Activo».
 const card=page.getByRole('article').filter({hasText:'Calentamiento Inovaris WA 4–6'});
 await expect(card.getByText('Protección activa',{exact:true})).toBeVisible();await expect(card.getByText('Activo',{exact:true})).toHaveCount(0);
 await expect(card.getByText(/Se abrió la protección porque una o más líneas fallaron/)).toBeVisible();await axe(page,'protected program');
 // Pause first (a person's decision), then review and recover: the pause stays.
 await card.getByRole('button',{name:'Pausar'}).click();await expect(card.getByText(/pausado por una persona y seguirá pausado/)).toBeVisible();
 await expect(card.getByText('Protección activa',{exact:true})).toBeVisible();await expect(card.getByRole('button',{name:'Revisar y reanudar'})).toBeVisible();
 await card.getByRole('button',{name:'Revisar protección'}).click();const dialog=page.getByRole('dialog');
 await expect(dialog.getByText(/Comprobación reciente y sana/).first()).toBeVisible();await expect(dialog.getByRole('button',{name:'Recuperar protección'})).toBeDisabled();await axe(page,'protection review');
 await dialog.getByLabel('Motivo (queda en la auditoría)').fill('Las tres líneas están sanas; la falla fue una lectura pasajera');
 await dialog.getByRole('button',{name:'Recuperar protección'}).click();
 await expect(page.getByText(/Protección recuperada. Si el calentamiento estaba pausado, sigue pausado/)).toBeVisible();
 expect(commands.map(c=>c.action)).toEqual(['pause','recover']);
 expect(commands[1]).toMatchObject({action:'recover',expectedVersion:3,recoveryHash:'d'.repeat(64),reason:'Las tres líneas están sanas; la falla fue una lectura pasajera'});
 expect(status).toBe('PAUSED');
 // H09: save → the resume fails → edit again → review → save: the second edit is saved, then resumed.
 await card.getByRole('button',{name:'Revisar y reanudar'}).click();const editor=page.getByRole('dialog');
 await editor.getByLabel('Nombre').fill('Calentamiento WA 4–6 (primera edición)');await editor.getByRole('button',{name:'Revisar',exact:true}).click();
 await editor.getByRole('checkbox',{name:/Confirmo que los 2 participantes externos/}).check();await editor.getByRole('button',{name:'Guardar e iniciar'}).click();
 await expect(editor.getByText('Esperando una comprobación reciente de la conexión.')).toBeVisible();
 await editor.getByLabel('Nombre').fill('Calentamiento WA 4–6 (segunda edición)');await editor.getByRole('button',{name:'Revisar',exact:true}).click();
 await editor.getByRole('checkbox',{name:/Confirmo que los 2 participantes externos/}).check();await editor.getByRole('button',{name:'Guardar e iniciar'}).click();
 await expect(editor).toHaveCount(0);
 const after=commands.slice(2);
 expect(after.map(c=>[c.action,c.expectedVersion])).toEqual([['configure',4],['resume',5],['configure',5],['resume',6]]);
 expect(after[2].config.name).toBe('Calentamiento WA 4–6 (segunda edición)');expect(after[2].operationId).not.toBe(after[0].operationId);
 expect(after[3]).toMatchObject({audienceConfirmed:true});expect(config.name).toBe('Calentamiento WA 4–6 (segunda edición)');
 await page.setViewportSize({width:390,height:844});await axe(page,'recovered program mobile');expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(1);
});
