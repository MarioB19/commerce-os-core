import {test,expect,type Page} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';

// All requests are intercepted; no gateway, customer or production database is used.
async function fixture(page:Page,deleteFailure=false) {
 const account={id:'33333333-3333-4333-8333-333333333333',name:'Número sintético',provider:'waha',status:'STOPPED',version:3,sending_enabled:false};
 const requests:{path:string;method:string;body:Record<string,unknown>}[]=[];
 let removed=false;
 await page.addInitScript(()=>sessionStorage.setItem('commerce-environment:fixture-workspace:fixture-user','REAL'));
 await page.route('**/v1/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,method=req.method();let data:unknown=[];
  if(method!=='GET') {
   const body=req.postDataJSON() as Record<string,unknown>;requests.push({path,method,body});
   if(method==='DELETE'&&path===`/v1/channel-accounts/${account.id}`) {
    if(deleteFailure){await route.fulfill({status:409,json:{error:{code:'UNLINK_BEFORE_DELETE',message:'Pulsa Desvincular WhatsApp y espera su confirmación para eliminar este número.'}}});return;}
    removed=true;data={id:account.id,deleted:true,history_preserved:true};
   }else if(path.endsWith('/commands'))data={id:'synthetic-command',status:'PENDING',kind:'channel_command',payload:body};
   else {await route.fulfill({status:400,json:{error:{code:'UNEXPECTED_FIXTURE_MUTATION',message:'Acción fuera del fixture'}}});return;}
  }else if(path==='/v1/me')data={user:{id:'fixture-user',name:'Operador sintético',email:'fixture@example.invalid'},workspace_id:'fixture-workspace',role:'owner',permissions:['*'],environment:'REAL'};
  else if(path==='/v1/channel-accounts')data=removed?[]:[account];
  else if(path===`/v1/channel-accounts/${account.id}`)data=account;
  else if(path.endsWith('/health'))data={state:'BLOCKED',next_action:'Revisar recepción',observations:[],official_quality:{value:null},capabilities:{},statistics:[],reception:{state:'CONFIGURATION_BLOCKED',webhook:{state:'MISMATCH'},envelopes:{received:0,pending:0,failed:0},messages:{received:0,last_received_at:null},sending_enabled:false}};
  else if(path.endsWith('/setup'))data={account_version:3,configuration_version:1,sending_enabled:false,options:{products:[],offers:[],workflows:[],agents:[],gateways:[]},effective_assignment:{},checks:[],ready:false,blockers:['Selecciona una oferta'],authorization:null};
  else if(path==='/v1/commands/synthetic-command')data={id:'synthetic-command',status:'FAILED',result:{error:'QR_OPERATION_NOT_AUTHORIZED',message:'La preparación de sesiones está deshabilitada para este entorno.',diagnostic:{action:'En Sistema → Operación, cambia Vinculación de números a Permitir conexión y QR. Puedes mantener los envíos congelados.'}}};
  await route.fulfill({json:{data}});
 });
 await page.goto('/settings/channels/advanced');
 await page.getByRole('button',{name:/Número sintético/}).click();
 return{requests,account};
}

test('failed channel commands show the explanation, recovery step and configuration link',async({page})=>{
 await fixture(page);
 await page.getByRole('button',{name:'Conectar',exact:true}).click();
 await page.getByRole('dialog',{name:'Número sintético',exact:true}).getByRole('button',{name:'Cerrar',exact:true}).click();
 const alert=page.getByRole('alert');
 await expect(alert).toContainText('La preparación de sesiones está deshabilitada');
 await expect(alert).toContainText('Permitir conexión y QR');
 await expect(alert.getByRole('link',{name:'Abrir configuración de operación'})).toHaveAttribute('href','/settings');
 await expect(alert).toContainText('Referencia: QR_OPERATION_NOT_AUTHORIZED');
});

test('unlinking requires confirmation and uses the selected real account',async({page})=>{
 const {requests,account}=await fixture(page);
 if(!await page.getByRole('button',{name:'Desvincular WhatsApp',exact:true}).isVisible())await page.getByText('Detener, reiniciar o desvincular',{exact:true}).click();
 await page.getByRole('button',{name:'Desvincular WhatsApp',exact:true}).click();
 const confirm=page.getByRole('dialog',{name:'Desvincular este número',exact:true});
 await expect(confirm).toContainText('necesitarás escanear otro QR');expect(requests).toHaveLength(0);
 await confirm.getByRole('button',{name:'Cancelar',exact:true}).click();expect(requests).toHaveLength(0);
 if(!await page.getByRole('button',{name:'Desvincular WhatsApp',exact:true}).isVisible())await page.getByText('Detener, reiniciar o desvincular',{exact:true}).click();
 await page.getByRole('button',{name:'Desvincular WhatsApp',exact:true}).click();
 await confirm.getByRole('button',{name:'Confirmar desvincular whatsapp',exact:true}).click();
 await expect(confirm).toBeHidden();expect(requests).toHaveLength(1);
 expect(requests[0]).toMatchObject({path:`/v1/channel-accounts/${account.id}/commands`,body:{type:'logout',environment:'REAL'}});
});

test('deleting a number confirms history preservation and removes its card on mobile',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 const {requests,account}=await fixture(page);
 if(!await page.getByRole('button',{name:'Eliminar número',exact:true}).isVisible())await page.getByText('Retirar número de Commerce OS',{exact:true}).click();
 await page.getByRole('button',{name:'Eliminar número',exact:true}).click();
 const confirm=page.getByRole('dialog',{name:'Eliminar este número de Commerce OS',exact:true});
 await expect(confirm).toContainText('conversaciones, ventas e historial se conservan');expect(requests).toHaveLength(0);
 expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
 await page.screenshot({path:'test-results/channel-delete-mobile.png'});
 await confirm.getByRole('button',{name:'Cancelar',exact:true}).click();expect(requests).toHaveLength(0);
 if(!await page.getByRole('button',{name:'Eliminar número',exact:true}).isVisible())await page.getByText('Retirar número de Commerce OS',{exact:true}).click();
 await page.getByRole('button',{name:'Eliminar número',exact:true}).click();
 await confirm.getByRole('button',{name:'Confirmar eliminar número',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByRole('button',{name:/Número sintético/})).toHaveCount(0);
 expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({path:`/v1/channel-accounts/${account.id}`,method:'DELETE',body:{environment:'REAL',expected_version:3,confirmation:'DELETE_CHANNEL_ACCOUNT'}});
});

test('a rejected deletion leaves the account and shows how to unlink first',async({page})=>{
 const {requests}=await fixture(page,true);
 if(!await page.getByRole('button',{name:'Eliminar número',exact:true}).isVisible())await page.getByText('Retirar número de Commerce OS',{exact:true}).click();
 await page.getByRole('button',{name:'Eliminar número',exact:true}).click();
 const confirm=page.getByRole('dialog',{name:'Eliminar este número de Commerce OS',exact:true});
 await confirm.getByRole('button',{name:'Confirmar eliminar número',exact:true}).click();
 await expect(confirm.getByRole('alert')).toContainText('Pulsa Desvincular WhatsApp');
 await expect(confirm).toBeVisible();expect(requests).toHaveLength(1);
 await confirm.getByRole('button',{name:'Cancelar',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Número sintético',exact:true})).toBeVisible();
});

test('shows reception failure independently from sending permission without exposing configuration',async({page})=>{
 await fixture(page);const section=page.getByRole('region',{name:'Recepción de mensajes'});
 await expect(section).toContainText('necesita reparación');await expect(section).toContainText('Mensajes entrantes: 0');
 await expect(section).toContainText('esto no impide recibir mensajes');
 await expect(section).toContainText('Reconectar');
});
