import {test,expect,type Page} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';
import {randomBytes,randomUUID} from 'node:crypto';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';

// V7 F8 (RF-17.e, RF-05/06, RF-08): from an empty product list to a published
// variant through the application only — product, first market, sale defaults,
// price with a link material, payment link and publication. The automated
// time is recorded as a complement; the RF-17.e limit is measured with people.
test.use({screenshot:'off',trace:'off',video:'off'});
const profile=process.env.WORKSPACE_ID??'local';
async function signIn(page:Page){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({email,password,name:'Dueña de prueba',workspace_id:profile,role:'owner'});
 await page.goto('/login');await page.getByLabel('Correo electrónico').fill(email);await page.getByLabel('Contraseña',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Entrar a Commerce OS'}).click();
 const chooser=page.getByRole('heading',{name:'Tus perfiles'});
 await expect(page.getByRole('navigation',{name:'Navegación del perfil'}).or(chooser)).toBeVisible();
 if(await chooser.isVisible()){await page.getByLabel('Perfil',{exact:true}).selectOption(profile);await page.getByRole('button',{name:'Cambiar a este perfil'}).click();}
}
test.afterAll(async()=>{await pool.end();});

test('creates, completes and publishes a variant from the application',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await signIn(page);
 const name='Curso e2e '+randomUUID().slice(0,8),started=Date.now();
 await page.goto('/products');await expect(page.getByRole('heading',{level:1,name:'Productos'})).toBeVisible();
 await page.getByRole('button',{name:'Crear producto'}).first().click();
 await page.getByLabel('Nombre del producto').fill(name);
 await page.getByRole('button',{name:'Crear producto'}).last().click();
 await page.waitForURL(/\/products\/[0-9a-f-]{36}\/variants\/[0-9a-f-]{36}\/sale$/);
 const sections=page.getByRole('navigation',{name:'Secciones de la variante'});
 await expect(sections.getByRole('link')).toHaveCount(5);
 await page.getByRole('button',{name:'Guardar venta'}).click();await expect(page.getByRole('status').filter({hasText:'Cambios guardados'})).toBeVisible();
 // Oferta y materiales: a link material, then price and deliverable.
 await sections.getByRole('link',{name:'Oferta y materiales'}).click();
 const materials=page.getByRole('form',{name:'Agregar material'});
 await materials.getByRole('radio',{name:'Enlace'}).check();await materials.getByLabel('Nombre').fill('Guía e2e');await materials.getByLabel('Enlace (https://)').fill('https://example.com/guia-e2e');
 await materials.getByRole('button',{name:'Agregar material'}).click();
 await expect(page.getByRole('list').getByText('Guía e2e')).toBeVisible();
 await page.getByLabel(/Precio/).fill('97');
 await page.getByLabel('Agregar material entregable').selectOption({label:'Guía e2e'});
 await page.getByRole('button',{name:'Guardar oferta'}).click();await expect(page.getByRole('status').filter({hasText:'Cambios guardados'})).toBeVisible();
 // Cobro: a payment link; the URL never comes back whole.
 await sections.getByRole('link',{name:'Cobro'}).click();
 await page.getByRole('button',{name:'Agregar enlace',exact:true}).click();
 await page.getByLabel('Etiqueta para el cliente').fill('Pagar con tarjeta');await page.getByLabel('Enlace (https://)').fill('https://pay.example.com/curso?ref=e2e');
 await page.getByRole('button',{name:'Guardar cobro'}).click();await expect(page.getByRole('status').filter({hasText:'Cambios guardados'})).toBeVisible();
 await expect(page.getByText('ref=e2e')).toHaveCount(0);
 // Publicar: applies to new conversations; the variant is ready to assign.
 await page.getByRole('button',{name:/Publicar/}).click();
 await expect(page.getByRole('status').filter({hasText:'Publicado. Asigna un número para empezar a vender.'})).toBeVisible();
 await expect(page.getByText('Listo para asignar').first()).toBeVisible();
 const seconds=Math.round((Date.now()-started)/1000);
 test.info().annotations.push({type:'rf-17.e-automated-seconds',description:String(seconds)});
 expect(seconds).toBeLessThan(900);
 const r=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();expect(r.violations.map(v=>v.id)).toEqual([]);
 await page.goto('/products');await expect(page.getByRole('link',{name})).toBeVisible();
 expect(errors).toEqual([]);
});
