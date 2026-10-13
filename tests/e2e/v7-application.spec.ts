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
