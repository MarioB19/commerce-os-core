import {test,expect,type Page} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';
const ids={product:'44444444-4444-4444-8444-444444444444',offer:'55555555-5555-4555-8555-555555555555',workflow:'66666666-6666-4666-8666-666666666666',agent:'77777777-7777-4777-8777-777777777777'};
async function fixture(page:Page,count:number){
 const product={id:ids.product,name:'Mi Ciclo Listo sintético',version:3,status:'PUBLISHED',asset_ids:[]};
 const configuration={product_id:ids.product,offer_version_id:ids.offer,workflow_version_id:ids.workflow,agent_version_id:ids.agent};
 const accounts=Array.from({length:count},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,name:'Número sintético '+(i+1),alias:'Número sintético '+(i+1),version:1,status:'STOPPED',uses_product:false,sending_enabled:false,assignments:[{product_id:'another-product',product_name:'Otro producto conservado'}]}));
 const assignments:any[]=[],writes:{body:any;key:string}[]=[];let partial=count===3;
 await page.route('**/v1/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname;let data:any=[],status=200;
  if(r.method()!=='GET'){
   if(path!=='/v1/assignments/batch'){await route.fulfill({status:400,json:{error:{message:'Unexpected synthetic mutation'}}});return;}
   const body=r.postDataJSON();writes.push({body,key:r.headers()['idempotency-key']!});
   const results=body.assignments.map((x:any)=>{const a=accounts.find(a=>a.id===x.account_id)!;if(partial&&a===accounts[2])return{account_id:a.id,product_id:ids.product,ok:false,code:'VERSION_CONFLICT'};const saved={id:'assignment-'+a.id,account_id:a.id,account_alias:a.alias,revision:1,state:'ACTIVE',authorization_registered:false,...configuration};assignments.push(saved);a.uses_product=true;a.assignments.push({product_id:ids.product,product_name:product.name});return{account_id:a.id,product_id:ids.product,ok:true,result:saved};});
   data={status:partial?'PARTIAL_FAILURE':'COMPLETE',results,succeeded:results.filter((x:any)=>x.ok).length,failed:results.filter((x:any)=>!x.ok).length,external_effects:false};status=partial?207:200;partial=false;
  }else if(path==='/v1/me')data={user:{id:'synthetic-ui-user',name:'Owner sintético',email:'fixture@example.invalid'},workspace_id:'synthetic-ui-workspace',role:'owner',permissions:['*'],environment:'REAL'};
  else if(path==='/v1/products')data=[product];
  else if(path==='/v1/products/'+ids.product)data=product;
  else if(path==='/v1/products/'+ids.product+'/assistant')data={product,next_actions:[],proposals:[],provider_called:false};
  else if(path==='/v1/products/'+ids.product+'/configuration')data={configuration_published:true,product,offer:{id:ids.offer},workflow:{id:ids.workflow},seller:{id:ids.agent},connections:{assigned_accounts:accounts.filter(a=>a.uses_product).length,sales_ai:{configured:false,state:'PROVIDER_PENDING',model:null}},accounts};
  else if(path==='/v1/channel-inventory'||path==='/v1/channel-accounts')data=accounts;
  else if(path==='/v1/assignments')data=assignments;
  else if(path==='/v1/offers')data=[{id:ids.offer,name:'Oferta publicada sintética',product_id:ids.product,status:'PUBLISHED'}];
  else if(path==='/v1/workflows')data=[{id:ids.workflow,name:'Flujo publicado sintético',product_id:ids.product,status:'PUBLISHED'}];
  else if(path==='/v1/agents')data=[{id:ids.agent,name:'Vendedor publicado sintético',product_id:ids.product,status:'PUBLISHED'}];
  else if(path==='/v1/warmup')data={installed:true,enabled:false,pool:null,accounts:[],plans:[],jobs:[],provider_verified:false};
  await route.fulfill({status,json:{data}});
 });
 await page.goto('/catalog?product='+ids.product);await expect(page.getByText('Paquete comercial publicado',{exact:true})).toBeVisible();return{writes,accounts,assignments};
}
const numbers=(page:Page)=>page.getByRole('navigation',{name:'Espacio del producto'}).getByRole('link',{name:'Números',exact:true}).click();
async function choosePackage(page:Page){await page.getByRole('combobox',{name:'Oferta',exact:true}).selectOption(ids.offer);await page.getByRole('combobox',{name:'Flujo',exact:true}).selectOption(ids.workflow);await page.getByRole('combobox',{name:'Vendedor',exact:true}).selectOption(ids.agent);await page.getByLabel('Frase explícita que selecciona este producto').fill('Quiero Mi Ciclo Listo');}
const selected=(page:Page,n:number)=>page.getByRole('checkbox',{name:new RegExp('^Número sintético '+n+' ')});
test.afterEach(async({page},info)=>{if(info.status==='passed')await page.screenshot({path:info.outputPath('commercial-configuration.png'),fullPage:true});await page.goto('about:blank');await page.unrouteAll({behavior:'wait'});});
test('zero numbers and no Sales provider leave a useful published product and independent navigation',async({page})=>{
 const f=await fixture(page,0);await expect(page.getByRole('link',{name:'Abrir vendedor'})).toHaveAttribute('href','/sales/agents/'+ids.agent);await numbers(page);await expect(page.getByRole('heading',{name:'Sin números registrados'})).toBeVisible();await expect(page.getByRole('link',{name:'Registrar un número →'})).toHaveAttribute('href','/sales/channels/whatsapp');expect(f.writes).toEqual([]);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(v=>v.id)).toEqual([]);
});
test('one later account creates an independent product relationship without enabling sending',async({page})=>{
 const f=await fixture(page,1);await numbers(page);await selected(page,1).check();await choosePackage(page);await page.getByRole('button',{name:'Guardar asignaciones seleccionadas'}).click();await expect(page.getByRole('status')).toContainText('Número sintético 1: Guardado; sin nueva autorización de envío');expect(f.writes).toHaveLength(1);
 expect(f.writes[0]!.body.assignments[0]).toMatchObject({product_id:ids.product,offer_version_id:ids.offer,workflow_version_id:ids.workflow,agent_version_id:ids.agent,expected_version:0,entry_rules:[{kind:'keyword',value:'Quiero Mi Ciclo Listo'}]});expect(f.accounts[0]!.sending_enabled).toBe(false);expect(f.accounts[0]!.assignments.map(a=>a.product_id)).toEqual(['another-product',ids.product]);await expect(selected(page,1)).not.toBeChecked();
});
test('three accounts report partial failure individually and retry only the pending relationship',async({page})=>{
 const f=await fixture(page,3);await numbers(page);for(let i=1;i<=3;i++)await selected(page,i).check();await choosePackage(page);await page.getByRole('button',{name:'Guardar asignaciones seleccionadas'}).click();
 await expect(page.getByRole('status')).toContainText('Número sintético 3: VERSION_CONFLICT');await expect(selected(page,1)).not.toBeChecked();await expect(selected(page,2)).not.toBeChecked();await expect(selected(page,3)).toBeChecked();
 await page.getByRole('button',{name:'Guardar asignaciones seleccionadas'}).click();await expect(page.getByRole('status')).toContainText('Número sintético 3: Guardado; sin nueva autorización de envío');expect(f.writes[0]!.body.assignments).toHaveLength(3);expect(f.writes[1]!.body.assignments).toHaveLength(1);expect(f.writes[1]!.body.assignments[0].account_id).toBe(f.accounts[2]!.id);expect(f.writes[0]!.key).not.toBe(f.writes[1]!.key);expect(f.writes.every(w=>w.key.length>=8)).toBe(true);expect(f.assignments).toHaveLength(3);expect(f.accounts.every(a=>!a.sending_enabled&&a.assignments.length===2)).toBe(true);
});
