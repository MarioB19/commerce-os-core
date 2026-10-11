import {test,expect,type Page} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';
import {randomBytes,randomUUID} from 'node:crypto';
import {appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {SMTPServer} from 'smtp-server';
import pg from 'pg';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';

test.use({screenshot:'off',trace:'off',video:'off'});
const origin=process.env.E2E_BASE_URL??'http://127.0.0.1:5173';
const smtpPort=Number(process.env.IDENTITY_TEST_SMTP_PORT??2527);
const privateDir=process.env.COMMERCE_CONFIG_DIR??join(homedir(),'.config','commerce-os-local');
let sequence=0;
function retain(value:string){mkdirSync(privateDir,{recursive:true,mode:0o700});appendFileSync(join(privateDir,'identity-test-secrets.env'),`TEST_SECRET_${++sequence}=${value}\n`,{mode:0o600});return value;}
const secret=()=>retain(randomBytes(24).toString('base64url'));
async function synthetic(role:any='viewer'){
 const password=secret(),email=randomUUID()+'@example.invalid';const p=await provisionUser({email,password,name:'Cuenta de prueba',workspace_id:process.env.WORKSPACE_ID??'local',role});return {...p,password,email};
}
async function login(page:Page,p:{email:string;password:string}){const r=await page.request.post('/api/auth/sign-in/email',{headers:{Origin:origin},data:{email:p.email,password:p.password}});expect(r.status()).toBe(200);}
async function fillPasswords(page:Page,current:string|undefined,next:string,confirmation=next){if(current)await page.getByLabel('Contraseña actual',{exact:true}).fill(current);await page.getByLabel('Nueva contraseña',{exact:true}).fill(next);await page.getByLabel('Confirmar nueva contraseña',{exact:true}).fill(confirmation);}
async function axe(page:Page){const r=await new AxeBuilder({page}).analyze();expect(r.violations.map(x=>({id:x.id,nodes:x.nodes.map(n=>n.target)}))).toEqual([]);}
test.afterAll(async()=>{await pool.end();});

test('Mi cuenta: keyboard, validation, current password, renewal and compact/mobile navigation',async({page})=>{
 const p=await synthetic(),next=secret();await login(page,p);await page.goto('/home');
 await page.getByRole('link',{name:'Mi cuenta',exact:true}).click();await expect(page.getByRole('heading',{name:'Seguridad',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Cambiar contraseña',exact:true}).click();await expect(page.getByLabel('Contraseña actual',{exact:true})).toBeFocused();await axe(page);
 await fillPasswords(page,p.password,next,secret());await page.getByRole('button',{name:'Cambiar contraseña',exact:true}).click();await expect(page.getByLabel('Confirmar nueva contraseña',{exact:true})).toBeFocused();
 await page.getByRole('button',{name:'Mostrar nueva contraseña',exact:true}).click();await expect(page.getByLabel('Nueva contraseña',{exact:true})).toHaveAttribute('type','text');await page.getByRole('button',{name:'Ocultar nueva contraseña',exact:true}).click();
 await fillPasswords(page,p.password,next);await page.getByRole('button',{name:'Cambiar contraseña',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'Contraseña actualizada'})).toBeVisible();await expect(page.getByLabel('Nueva contraseña',{exact:true})).toHaveValue('');
 await page.reload();await expect(page.getByRole('heading',{name:'Seguridad',exact:true})).toBeVisible();await axe(page);
 await page.getByRole('button',{name:'Contraer menú'}).click();await page.getByRole('link',{name:'Mi cuenta · Seguridad',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Abrir menú'}).click();await page.getByRole('link',{name:'Mi cuenta · Seguridad',exact:true}).click();await expect(page.getByRole('heading',{name:'Seguridad',exact:true})).toBeVisible();await axe(page);
 await page.screenshot({path:'test-results/account-security-mobile.png'});await page.setViewportSize({width:1440,height:1050});await page.screenshot({path:'test-results/account-security-desktop.png'});
});

test('recovery: SMTP loopback, token removed from URL, reset, used link, fresh login and accessible Spanish mail',async({page,browser})=>{
 const p=await synthetic(),next=secret();let raw='',complete=false;
 const smtp=new SMTPServer({authOptional:true,disabledCommands:['STARTTLS','AUTH'],logger:false,onData(stream,_session,done){stream.on('data',d=>{raw+=d.toString();});stream.on('end',()=>{complete=true;done();});}});
 await new Promise<void>(resolve=>smtp.listen(smtpPort,'127.0.0.1',resolve));
 const admin=new pg.Client({connectionString:process.env.DATABASE_URL});await admin.connect();const previous=(await admin.query('SELECT * FROM identity_mail_settings')).rows[0];
 try{
  for(const path of ['/forgot-password','/reset-password','/account/security']){const response=await page.request.get(path);expect(response.headers()['cache-control']).toContain('no-store');expect(response.headers()['referrer-policy']).toBe('no-referrer');}
  // The fixture changes only this isolated test database. The real transport is still gated by server allowlist.
  await admin.query(`INSERT INTO identity_mail_settings(singleton,version,enabled,config,updated_by) VALUES(true,1,true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET enabled=true,config=$1,secret_ciphertext=NULL`,[{mode:'local',host:'localhost',port:smtpPort,tls:'none',from:'security@example.invalid',name:'Commerce OS'},p.id]);
  await page.goto('/login');await page.getByRole('link',{name:'Olvidé mi contraseña'}).click();await expect(page.getByRole('heading',{name:'Recupera tu acceso'})).toBeVisible();await axe(page);
  await page.getByLabel('Correo electrónico').fill(p.email);await page.getByRole('button',{name:'Enviar enlace de recuperación'}).click();await expect(page.getByRole('status')).toContainText('Si existe una cuenta activa');
  // DATA can arrive in several chunks; headers alone do not contain the recovery link.
  await expect.poll(()=>complete,{timeout:20000}).toBe(true);
  const decoded=raw.replace(/=\r?\n/g,'').replace(/=([0-9A-F]{2})/g,(_,h)=>String.fromCharCode(parseInt(h,16)));
  const token=retain(decoded.match(/reset-password#token=([A-Za-z0-9_-]+)/)![1]!);
  const context=await browser.newContext({baseURL:origin});const recovery=await context.newPage();await recovery.goto(origin+'/reset-password#token='+token);
  await expect(recovery.getByRole('heading',{name:'Elige una nueva contraseña'})).toBeVisible();await expect(recovery).toHaveURL(origin+'/reset-password');await axe(recovery);
  await fillPasswords(recovery,undefined,next);await recovery.getByRole('button',{name:'Restablecer contraseña',exact:true}).click();await expect(recovery.getByRole('heading',{name:'Contraseña restablecida'})).toBeVisible();
  await recovery.getByRole('link',{name:'Iniciar sesión',exact:true}).click();await expect(recovery.getByRole('heading',{name:'Bienvenido de nuevo'})).toBeVisible();
  await login(recovery,{...p,password:next});await recovery.goto('/account/security');await expect(recovery.getByRole('heading',{name:'Seguridad',exact:true})).toBeVisible();
  await recovery.goto(origin+'/reset-password#token='+token);await fillPasswords(recovery,undefined,secret());await recovery.getByRole('button',{name:'Restablecer contraseña',exact:true}).click();await expect(recovery.getByRole('alert')).toContainText('enlace');await expect(recovery.getByRole('link',{name:'Solicitar otro enlace'})).toBeVisible();await axe(recovery);
  await context.close();
  // A redacted HTML preview is safe to retain and inspect; no usable link survives.
  const {resetMailTemplate}=await import('../../apps/api/src/identity-mail.js');const html=resetMailTemplate(origin+'/reset-password#token=REDACTED').html;
  await page.setContent(html);await axe(page);await page.screenshot({path:'test-results/password-mail-preview.png'});
 }finally{await new Promise<void>(resolve=>smtp.close(()=>resolve()));if(previous)await admin.query('UPDATE identity_mail_settings SET enabled=$1,config=$2,secret_ciphertext=$3 WHERE singleton=true',[previous.enabled,previous.config,previous.secret_ciphertext]);else await admin.query('DELETE FROM identity_mail_settings');await admin.end();}
});

test('account configuration owner UI, inactive permissions, reset refresh and ambiguous network result',async({page})=>{
 const p=await synthetic('owner');await login(page,p);await page.goto('/settings/integrations/mail');await expect(page.getByRole('heading',{name:'Correo transaccional',exact:true})).toBeVisible();await axe(page);
 await page.goto('/account/security');await page.route('**/api/auth/change-password',route=>route.abort());await fillPasswords(page,p.password,secret());await page.getByRole('button',{name:'Cambiar contraseña',exact:true}).click();await expect(page.getByRole('alert')).toContainText('No pudimos confirmar');await page.unroute('**/api/auth/change-password');
 await page.goto('/reset-password');await expect(page.getByRole('link',{name:'Solicitar otro enlace'})).toBeVisible();await axe(page);
 await page.goto('/forgot-password');await page.setViewportSize({width:390,height:844});await axe(page);await page.screenshot({path:'test-results/forgot-password-mobile.png'});
});


test('Resend preset requires explicit save/key, disables sending and clears the key after save',async({page})=>{
 const p=await synthetic('owner');await login(page,p);
 let metadata={version:1,enabled:true,config:{mode:'local',host:'localhost',port:2527,tls:'none',from:'security@example.invalid',name:'Commerce OS'},credentials_configured:false,diagnostic:'NOT_CONFIGURED',diagnosed_at:null};
 let saves=0;const apiKey=secret();
 await page.route('**/v1/identity/mail/jobs?environment=REAL',route=>route.fulfill({json:{data:[]}}));
 await page.route('**/v1/identity/mail?environment=REAL',async route=>{
  if(route.request().method()==='PUT'){
   saves++;const body=route.request().postDataJSON();expect(body.enabled).toBe(false);expect(body.username).toBe('resend');expect(body.password===apiKey).toBe(true);
   expect(body.config).toMatchObject({mode:'remote',host:'smtp.resend.com',port:465,tls:'implicit',from:'security@example.invalid'});
   metadata={...metadata,version:2,enabled:false,config:body.config,credentials_configured:true};
  }
  await route.fulfill({json:{data:metadata}});
 });
 await page.goto('/settings/integrations/mail');await page.getByRole('button',{name:'Configurar Resend',exact:true}).click();
 await expect(page.getByLabel('Correo remitente',{exact:true})).toHaveValue('security@example.invalid');
 await expect(page.getByLabel('Host SMTP',{exact:true})).toHaveValue('smtp.resend.com');await expect(page.getByLabel('Puerto',{exact:true})).toHaveValue('465');await expect(page.getByLabel('Seguridad de conexión')).toHaveValue('implicit');await expect(page.getByLabel('Usuario SMTP')).toHaveValue('resend');await expect(page.getByLabel('Envío de recuperación')).toHaveValue('disabled');expect(saves).toBe(0);
 const field=page.getByLabel('API key de Resend');await expect(field).toHaveAttribute('type','password');await expect(field).toHaveValue('');await expect(field).toHaveAttribute('required','');await axe(page);
 await field.fill(apiKey);await page.getByRole('button',{name:'Guardar configuración',exact:true}).click();await expect(page.getByRole('status')).toContainText('Configuración guardada');expect(saves).toBe(1);await expect(field).toHaveValue('');
});
