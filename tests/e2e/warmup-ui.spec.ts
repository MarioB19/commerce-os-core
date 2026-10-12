import {test,expect} from '@playwright/test';
import {closureFixture} from './support/closure-fixture.js';
import {evidencePath} from '../support/evidence.js';

for(const example of [{turns:4,phase:2,feasible:'5–6 conversaciones distintas'},{turns:5,phase:3,feasible:'12 conversaciones distintas'}])test(`warm-up editor approves ${example.turns} explicit turns compatible with phase ${example.phase}`,async({page})=>{
 await closureFixture(page);const submitted:Record<string,unknown>[]=[];
 await page.route('**/v1/warmup/content?environment=REAL',route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{data:[]}});
  submitted.push(route.request().postDataJSON());return route.fulfill({status:201,json:{data:{id:'owned-content-fixture'}}});
 });
 await page.goto('/settings/warmup/legacy');await page.getByRole('button',{name:'Agregar contenido aprobado'}).click();
 const modal=page.getByRole('dialog',{name:'Aprobar conversación del pool propio'}),guide=modal.getByRole('region',{name:'Límites y compatibilidad por fase'}),save=modal.getByRole('button',{name:'Guardar contenido aprobado'});
 await expect(guide.getByRole('row').filter({hasText:`Fase ${example.phase} ·`})).toContainText('Esta longitud sola no cubre la fase');
 await modal.getByLabel('Nombre de la conversación',{exact:true}).fill('Contenido propio sintético de verificación');
 for(let i=2;i<example.turns;i++)await modal.getByRole('button',{name:'Añadir turno',exact:true}).click();
 await expect(guide.getByRole('row').filter({hasText:`Fase ${example.phase} ·`})).toContainText(example.feasible);
 for(let i=1;i<=example.turns;i++)await modal.getByLabel(`Mensaje del turno ${i}`,{exact:true}).fill(`Contenido ficticio aprobado, turno ${i}`);
 await expect(save).toBeDisabled();expect(submitted).toEqual([]);
 await modal.getByRole('checkbox',{name:/Confirmo que todos los turnos/}).check();await expect(save).toBeEnabled();
 if(example.phase===3){await modal.evaluate(element=>{element.scrollTop=0;});await page.screenshot({path:evidencePath('v5-ui/warmup-content-editor-1440.png')});}
 await save.click();await expect(modal).toBeHidden();
 expect(submitted).toEqual([{label:'Contenido propio sintético de verificación',turns:Array.from({length:example.turns},(_,i)=>({kind:'text',text:`Contenido ficticio aprobado, turno ${i+1}`})),ownership_confirmed:true,environment:'REAL'}]);
});

test('warm-up editor preserves drafts, supports media and never exceeds twenty turns',async({page})=>{
 await closureFixture(page);const submitted:Record<string,unknown>[]=[];
 await page.route('**/v1/assets?**',route=>route.fulfill({json:{data:[{id:'00000000-0000-4000-8000-000000000201',name:'Documento propio de prueba',kind:'file',status:'READY',mime_type:'application/pdf'},{id:'invalid-asset',name:'Documento pendiente',kind:'file',status:'DRAFT',mime_type:'application/pdf'}]}}));
 await page.route('**/v1/warmup/content?environment=REAL',route=>route.request().method()==='GET'?route.fulfill({json:{data:[]}}):(submitted.push(route.request().postDataJSON()),route.fulfill({json:{data:{id:'media-content-fixture'}}})));
 await page.goto('/settings/warmup/legacy');await page.getByRole('button',{name:'Agregar contenido aprobado'}).click();
 const modal=page.getByRole('dialog',{name:'Aprobar conversación del pool propio'}),add=modal.getByRole('button',{name:'Añadir turno',exact:true});
 await modal.getByLabel('Nombre de la conversación',{exact:true}).fill('Borrador propio conservado');
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'Agregar contenido aprobado'}).click();await expect(modal.getByLabel('Nombre de la conversación',{exact:true})).toHaveValue('Borrador propio conservado');
 for(let i=2;i<20;i++)await add.click();await expect(add).toBeDisabled();await expect(modal.getByRole('group',{name:/^Turno \d+ ·/})).toHaveCount(20);
 for(let i=20;i>2;i--)await modal.getByRole('button',{name:`Quitar turno ${i}`,exact:true}).click();
 await modal.getByLabel('Mensaje del turno 1',{exact:true}).fill('Referencia explícita a un documento propio');
 await modal.getByRole('combobox',{name:'Tipo del turno 2',exact:true}).selectOption('document');
 const files=modal.getByLabel('Archivo aprobado del turno 2',{exact:true});await expect(files.locator('option')).toHaveCount(2);await files.selectOption('00000000-0000-4000-8000-000000000201');
 const checkbox=modal.getByRole('checkbox',{name:/Confirmo que todos los turnos/});await checkbox.check();await modal.getByLabel('Texto opcional del turno 2',{exact:true}).fill('Archivo propio de demostración');await expect(checkbox).not.toBeChecked();await checkbox.check();
 await modal.getByRole('button',{name:'Guardar contenido aprobado'}).click();await expect(modal).toBeHidden();
 expect(submitted[0]).toMatchObject({turns:[{kind:'text',text:'Referencia explícita a un documento propio'},{kind:'document',text:'Archivo propio de demostración',asset_id:'00000000-0000-4000-8000-000000000201'}],ownership_confirmed:true,environment:'REAL'});
});

test('numbers show persisted plan, ACK activity and planned pair concentration without a delivery claim',async({page})=>{
 await closureFixture(page);
 await page.route('**/v1/channel-accounts?environment=REAL',route=>route.fulfill({json:{data:[{id:'account-a',name:'Negocio A',provider:'waha',status:'STOPPED'},{id:'account-b',name:'Negocio B',provider:'waha',status:'STOPPED'}]}}));
 await page.route('**/v1/warmup?environment=REAL',route=>route.fulfill({json:{data:{installed:true,enabled:false,pool:{id:'pool-fixture',enabled:false,allow_small_pool_concentration:true},accounts:[{account_id:'account-a',status:'AWAITING_CONTENT',effective_days:3},{account_id:'account-b',status:'WARMING',effective_days:3}],plans:[{id:'plan-fixture',account_id:'account-a',local_date:'2026-09-08',effective_day:4,budget:{min_messages:20,max_messages:40},planned_messages:24,delivered_messages:12,planned_conversations:6,status:'PARTIAL'}],jobs:[],pair_stats:[{account_a:'account-a',account_b:'account-b',conversations:6,total_a:12,total_b:30}],provider_verified:false}}}));
 await page.setViewportSize({width:360,height:1000});await page.goto('/settings/channels/advanced');
 const plan=page.getByRole('region',{name:'Planes de warm-up y mensajes con ACK'});await expect(plan).toContainText('Negocio A');await expect(plan).toContainText('20–40');await expect(plan.getByRole('cell',{name:'24',exact:true})).toBeVisible();await expect(plan.getByRole('cell',{name:'12',exact:true})).toBeVisible();await expect(plan).toContainText('Parcial');
 const concentration=page.getByRole('region',{name:'Concentración del pool',exact:true});await expect(concentration).toContainText('100 %');await expect(concentration).toContainText('Excepción de pool pequeño aceptada');await expect(concentration).toContainText('no es una tasa de entrega');
 const pairs=page.getByRole('region',{name:'Concentración registrada por pareja'});await expect(pairs).toContainText('50 %');await expect(pairs).toContainText('20 %');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(await page.locator('.warmup-observations p').evaluateAll(elements=>elements.every(element=>element.getBoundingClientRect().right<=innerWidth&&element.scrollWidth<=element.clientWidth+1))).toBe(true);
 const {AxeBuilder}=await import('@axe-core/playwright');const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(v=>v.id)).toEqual([]);
 await page.screenshot({path:evidencePath('v5-ui/warmup-plans-concentration-360.png'),fullPage:true});
});
