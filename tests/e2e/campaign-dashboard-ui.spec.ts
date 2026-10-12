import {test,expect,type Page} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';
import {closureFixture} from './support/closure-fixture.js';
import {evidencePath} from '../support/evidence.js';

const product={id:'catalog-costura',name:'Costura que Vende · demo'};
const metric={id:'campaign-demo',name:'WA | TEST | Costura que Vende | Video · demo',day:'2026-09-08',meta_ad_account_id:'act_demo',campaign_id:'campaign-demo',ad_id:'ad-demo',spend_minor:48000,revenue_minor:125000,sales:10,attributed_sales:8,attributed_revenue_minor:100000,cpa_minor:6000,roas:2.08,balance_minor:77000,average_ticket_minor:12500,cost_per_meta_conversation_minor:2000,conversations:'24',impressions:'4800',clicks:'180',extraction:{key:'costura que vende',label:'Costura que Vende',source:'CAMPAIGN_NAME'},product_resolution:{status:'EXACT_NAME_CANDIDATE',product_ids:[],candidate_product_id:product.id}};
function report(partial=false){return {summary:{...metric},series:Array.from({length:7},(_,i)=>({...metric,day:`2026-09-0${i+2}`,spend_minor:[3000,6000,7000,8000,7000,8000,9000][i],revenue_minor:[3000,14000,9000,25000,16000,21000,37000][i]})),groups:{products:[{...metric,id:'campaign-name:costura que vende',name:'Costura que Vende',source:'CAMPAIGN_NAME',extracted_product:'costura que vende',product_id:null},{...metric,id:'unassigned',name:'Sin producto',source:'UNASSIGNED',spend_minor:0,revenue_minor:0,sales:0,attributed_sales:0,attributed_revenue_minor:0,cpa_minor:null,roas:null,balance_minor:0}],campaigns:[metric],ads:[{...metric,id:'ad-demo',name:'Video de demostración'}]},quality:{status:partial?'PARTIAL':'SYNCED',source:'META_API',available:true,complete:true,tax_missing:false,excluded_accounts:[],accounts:[{meta_ad_account_id:'act_demo',last_success_at:'2026-09-08T17:00:00Z',status:'SYNCED',tax_bps:null}],controls:[{classification:'PENDING',orders:2,documents:2,amount_minor:'20000'},{classification:'TEST',orders:1,documents:1,amount_minor:'10000'}],unattributed:{sales:2,revenue_minor:25000},spend_control:{differences:0,difference_minor:0,unassigned_spend_minor:48000},coverage_sales:.8,coverage_revenue:.8},options:{products:[product],extracted_products:[{id:'costura que vende',name:'Costura que Vende',source:'CAMPAIGN_NAME'}],campaigns:[{id:'campaign-demo',name:metric.name,meta_ad_account_id:'act_demo'}],ads:[{id:'ad-demo',name:'Video de demostración',meta_ad_account_id:'act_demo',campaign_id:'campaign-demo'}],accounts:[{id:'act_demo',name:'Cuenta de demostración',currency:'MXN',timezone:'America/Mexico_City'}]},measured_at:'2026-09-08T17:00:00Z',revision:'synthetic-dashboard-demo',cache:{status:'HIT',ttl_ms:30000,expires_at:'2026-09-08T17:00:30Z'}};}
async function dashboardFixture(page:Page,partial=false){
 const all=await closureFixture(page),reads:URL[]=[],writes:URL[]=[];let limited=false;const payload=report(partial);
 await page.route('**/v1/reports/campaign-performance?**',async route=>{const url=new URL(route.request().url());reads.push(url);if(limited){await route.fulfill({status:429,headers:{'Retry-After':'30'},json:{error:{code:'RATE_LIMITED'}}});return;}await route.fulfill({json:{data:{...payload,filters:Object.fromEntries(url.searchParams)}}});});
 await page.route('**/v1/meta/insights/sync?**',async route=>{writes.push(new URL(route.request().url()));expect(route.request().postDataJSON().environment).toBe('REAL');await route.fulfill({json:{data:{status:'SYNCED',source:'META_API'}}});});
 await page.goto('/campaigns');await expect(page.getByRole('heading',{name:'Campañas',exact:true})).toBeVisible();await expect(page.getByLabel('Balance publicitario del periodo')).toContainText('$770.00');
 return {all,reads,writes,income:(amount:number)=>{payload.summary.revenue_minor=amount;payload.summary.balance_minor=amount-payload.summary.spend_minor;},limit:()=>{limited=true;}};
}
test.afterEach(async({page})=>{await page.unrouteAll({behavior:'wait'});});

test('dashboard reads once, does not poll or reload on focus, and keeps REAL exact',async({page})=>{
 await page.clock.install();const f=await dashboardFixture(page);expect(f.reads).toHaveLength(1);
 await page.clock.fastForward(65000);await page.evaluate(()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(200);
 expect(f.reads).toHaveLength(1);expect(f.writes).toHaveLength(0);expect(f.all.some(r=>r.path==='/v1/campaign-products')).toBe(false);
 expect(f.reads.every(r=>r.searchParams.get('environment')==='REAL')).toBe(true);expect(f.all.every(r=>r.environment==='REAL')).toBe(true);
});
test('rapid date edits settle into one request and extracted labels remain distinct from catalog and ads',async({page})=>{
 const f=await dashboardFixture(page);await page.getByLabel('Desde',{exact:true}).fill('2026-09-01');await page.getByLabel('Hasta',{exact:true}).fill('2026-09-08');await expect.poll(()=>f.reads.length).toBe(2);expect(f.reads.at(-1)!.searchParams.get('from')).toBe('2026-09-01');
 await page.getByLabel('Producto promocionado',{exact:true}).selectOption('campaign-name:costura que vende');await expect.poll(()=>f.reads.length).toBe(3);expect(f.reads.at(-1)!.searchParams.get('extracted_product')).toBe('costura que vende');expect(f.reads.at(-1)!.searchParams.has('product_id')).toBe(false);await expect(page.getByText('Esta etiqueta organiza el gasto',{exact:false})).toBeVisible();
 await page.getByLabel('Anuncio',{exact:true}).selectOption('ad-demo');await expect.poll(()=>f.reads.length).toBe(4);expect(Object.fromEntries(f.reads.at(-1)!.searchParams)).toMatchObject({ad_id:'ad-demo',campaign_id:'campaign-demo',meta_ad_account_id:'act_demo'});
 await page.getByLabel('Producto promocionado',{exact:true}).selectOption(product.id);await expect.poll(()=>f.reads.length).toBe(5);expect(f.reads.at(-1)!.searchParams.get('product_id')).toBe(product.id);expect(f.reads.at(-1)!.searchParams.has('extracted_product')).toBe(false);
});
test('one explicit refresh retains the last cut on 429 without automatic retries or unrelated invalidation',async({page})=>{
 const f=await dashboardFixture(page);const initialOtherReads=f.all.length;f.limit();await page.getByRole('button',{name:'Actualizar',exact:true}).click();await expect(page.getByText('Se conserva el último corte cargado.',{exact:false})).toBeVisible();await expect(page.getByLabel('Balance publicitario del periodo')).toContainText('$770.00');await page.waitForTimeout(2500);
 expect(f.writes).toHaveLength(1);expect(f.reads).toHaveLength(2);expect(f.all.length).toBe(initialOtherReads);await expect(page.getByText('Corte en caché',{exact:false})).toBeVisible();
});
test('table search and grouping are local; a candidate requires explicit versioned classification',async({page})=>{
 const f=await dashboardFixture(page);await page.getByRole('button',{name:'Por campaña',exact:true}).click();await expect(page.getByText('Nombre de campaña · candidato por confirmar')).toBeVisible();await page.getByLabel('Buscar en esta tabla').fill('inexistente');await expect(page.getByText('Sin actividad en este periodo.')).toBeVisible();await page.getByLabel('Buscar en esta tabla').fill('');await page.getByLabel('Ordenar por').selectOption('name');expect(f.reads).toHaveLength(1);expect(f.writes).toHaveLength(0);
 await page.getByRole('button',{name:'Confirmar producto',exact:true}).click();await expect.poll(()=>f.all.filter(r=>r.path==='/v1/campaign-products').length).toBe(1);await page.getByRole('button',{name:/Asignar producto/}).click();await expect(page.getByRole('dialog').getByLabel('Producto',{exact:true})).toHaveValue(product.id);expect(f.all.filter(r=>r.method!=='GET')).toHaveLength(0);
});
test('partial snapshot is explicit and dashboard reflows with sanitized visual evidence',async({page})=>{
 test.setTimeout(180000);await dashboardFixture(page,true);await page.emulateMedia({reducedMotion:'reduce'});await expect(page.getByRole('heading',{name:'Resultado parcial del periodo'})).toBeVisible();await expect(page.getByText('Fuente parcial',{exact:true})).toBeVisible();await expect(page.getByText('Fuente parcial',{exact:true})).toHaveClass(/badge-warning/);await expect(page.getByText('Periodo cubierto',{exact:false})).toHaveCount(0);
 for(const width of [1440,1024,768,390,320]){await page.setViewportSize({width,height:1000});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`reflow ${width}`).toBe(true);const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(a.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)})),`axe ${width}`).toEqual([]);await page.screenshot({path:evidencePath(`campaign-dashboard/dashboard-partial-${width}.png`),fullPage:true});}
});
test('missing Meta data never becomes simulated data or zero spend',async({page})=>{
 await closureFixture(page);await page.goto('/campaigns');await expect(page.getByText('Sin lectura de Meta',{exact:false})).toBeVisible();await expect(page.getByRole('heading',{name:'Falta el gasto para calcular el balance'})).toBeVisible();await expect(page.locator('.performance-kpi').filter({hasText:'Gasto publicitario'}).locator('.kpi-value')).toHaveText('No disponible');await expect(page.getByText('Fixtures de simulación',{exact:false})).toHaveCount(0);
});

test('queued Insights update follows only its job and refreshes the report once after completion',async({page})=>{
 await page.clock.install();const f=await dashboardFixture(page);const job='11111111-1111-4111-8111-111111111111';let statusReads=0;
 await page.route('**/v1/meta/insights/sync?**',route=>route.fulfill({status:202,json:{data:{id:job,status:'PENDING'}}}));
 await page.route('**/v1/meta/insights/status?**',route=>{const url=new URL(route.request().url());expect(url.searchParams.get('job_id')).toBe(job);expect(url.searchParams.get('environment')).toBe('REAL');statusReads++;return route.fulfill({json:{data:[{id:job,status:statusReads===1?'PENDING':statusReads===2?'RUNNING':'SYNCED'}]}});});
 await page.getByRole('button',{name:'Actualizar',exact:true}).click();await expect.poll(()=>statusReads).toBe(1);expect(f.reads).toHaveLength(1);await expect(page.getByText('Actualización de Meta en curso')).toBeVisible();
 await page.clock.fastForward(3100);await expect.poll(()=>statusReads).toBe(2);expect(f.reads).toHaveLength(1);f.income(180000);
 await page.clock.fastForward(3100);await expect(page.getByText('Actualización de Meta terminada')).toBeVisible();await expect(page.getByRole('button',{name:'Ver ingresos',exact:true})).toHaveText('$1,800.00');expect(f.reads).toHaveLength(2);
 await page.clock.fastForward(65000);expect(statusReads).toBe(3);expect(f.reads).toHaveLength(2);
});
test('leaving the dashboard cancels its job monitor and ignores late completion',async({page})=>{
 const f=await dashboardFixture(page);const job='22222222-2222-4222-8222-222222222222';let release!:()=>void,started=false,statusReads=0;const waiting=new Promise<void>(resolve=>release=resolve);
 await page.route('**/v1/meta/insights/sync?**',route=>route.fulfill({status:202,json:{data:{id:job,status:'PENDING'}}}));
 await page.route('**/v1/meta/insights/status?**',async route=>{started=true;statusReads++;await waiting;await route.fulfill({json:{data:[{id:job,status:'SYNCED'}]}}).catch(()=>{});});
 await page.getByRole('button',{name:'Actualizar',exact:true}).click();await expect.poll(()=>started).toBe(true);await page.getByRole('link',{name:'Productos y ofertas',exact:true}).click();await expect(page.getByRole('button',{name:'Nuevo producto',exact:true})).toBeVisible();release();await page.waitForTimeout(3500);expect(statusReads).toBe(1);expect(f.reads).toHaveLength(1);await expect(page.getByText('Actualización de Meta terminada')).toHaveCount(0);
});
test('Insights scheduled retry waits until next attempt instead of polling during cooldown',async({page})=>{
 await page.clock.install();const f=await dashboardFixture(page);const job='33333333-3333-4333-8333-333333333333';let statusReads=0;
 await page.route('**/v1/meta/insights/sync?**',route=>route.fulfill({status:202,json:{data:{id:job,status:'PENDING'}}}));
 await page.route('**/v1/meta/insights/status?**',async route=>{statusReads++;const next=await page.evaluate(()=>new Date(Date.now()+240000).toISOString());await route.fulfill({json:{data:[{id:job,status:'PENDING',next_attempt_at:next}]}});});
 await page.getByRole('button',{name:'Actualizar',exact:true}).click();await expect.poll(()=>statusReads).toBe(1);await expect(page.getByText('Próximo intento:',{exact:false})).toBeVisible();await page.clock.fastForward(120000);expect(statusReads).toBe(1);expect(f.reads).toHaveLength(1);
});

test('pending command monitor stops polling after rate limit and offers an explicit retry',async({page})=>{
 await page.clock.install();await closureFixture(page);let reads=0;
 await page.route('**/v1/commands/simulation-command?**',route=>{reads++;return reads===1?route.fulfill({json:{data:{id:'simulation-command',status:'PENDING'}}}):route.fulfill({status:429,headers:{'Retry-After':'30'},json:{error:{code:'RATE_LIMITED'}}});});
 await page.goto('/settings/tests?workflow=flow-fixture');await page.getByRole('button',{name:'Activar laboratorio de pruebas'}).click();await page.getByRole('button',{name:'Crear copia de prueba'}).click();await expect(page.getByText('Copia de prueba creada.',{exact:false})).toBeVisible();await page.getByRole('button',{name:'Iniciar prueba',exact:true}).click();await page.getByRole('button',{name:'Simulador',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Iniciar simulación'}).click();await expect(page.getByRole('dialog')).toContainText('Comando registrado');await page.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();await expect.poll(()=>reads).toBe(2);
 await expect(page.getByText('Hay demasiadas solicitudes.',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'Reintentar',exact:true})).toBeVisible();await page.clock.fastForward(65000);expect(reads).toBe(2);
});

test('reopened receipt review follows worker updates and restores using the current version',async({page})=>{
 await closureFixture(page);
 let receipt={id:'receipt-live-fixture',order_id:'order-live-fixture',version:1,status:'APPROVED',commercial_classification:'GENUINE',amount_minor:9700,currency:'MXN'};
 const order={id:'order-live-fixture',version:1,status:'RECEIPT_APPROVED',sale_status:'RECOGNIZED',commercial_classification:'COMMERCIAL',amount_minor:9700,sale_amount_minor:9700,currency:'MXN'};
 const actions:Record<string,unknown>[]=[];
 await page.route('**/v1/orders?**',route=>route.fulfill({json:{data:[order],meta:{total:1}}}));
 await page.route('**/v1/orders/order-live-fixture?**',route=>route.fulfill({json:{data:order}}));
 await page.route('**/v1/receipts?**',route=>route.fulfill({json:{data:[receipt],meta:{total:1}}}));
 await page.route('**/v1/receipts/receipt-live-fixture/classification?**',route=>{actions.push(route.request().postDataJSON() as Record<string,unknown>);return route.fulfill({status:202,json:{data:{id:'queued-receipt-fixture',status:'PENDING'}}});});
 await page.goto('/sales/orders?order=order-live-fixture');
 await page.getByRole('dialog').getByRole('button',{name:'Abrir receipt-live-fixture',exact:true}).click();
 await page.getByRole('button',{name:'Marcar como falso',exact:true}).click();
 await page.getByRole('dialog').last().getByLabel('Motivo',{exact:true}).fill('Corrección sintética pendiente de procesarse');
 await page.getByRole('dialog').last().getByRole('button',{name:'Guardar',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(1);
 await page.getByRole('dialog').getByRole('button',{name:'Cerrar',exact:true}).click();
 await page.getByRole('button',{name:'Abrir order-live-fixture',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Abrir receipt-live-fixture',exact:true}).click();
 await expect(page.getByRole('button',{name:'Marcar como falso',exact:true})).toBeVisible();
 // The queued worker commits after the operator has selected the cached receipt.
 receipt={...receipt,commercial_classification:'FALSE',version:2};
 await expect(page.getByRole('button',{name:'Restaurar comprobante',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Restaurar comprobante',exact:true}).click();
 await page.getByRole('dialog').last().getByLabel('Motivo',{exact:true}).fill('Restaurar la versión vigente del comprobante');
 await page.getByRole('dialog').last().getByRole('button',{name:'Guardar',exact:true}).click();
 await expect.poll(()=>actions.length).toBe(2);
 expect(actions[1]).toMatchObject({environment:'REAL',classification:'GENUINE',expected_version:2});
});

test('mobile campaign filters retain readable widths and usable controls at 320 and 390 pixels',async({page})=>{
 await dashboardFixture(page);
 for(const width of [320,390]){
  await page.setViewportSize({width,height:1000});
  const controls=page.locator('.performance-filters input,.performance-filters select');
  const sizes=await controls.evaluateAll(elements=>elements.map(element=>{const rect=element.getBoundingClientRect();return{label:element.closest('label')?.querySelector('span')?.textContent?.trim(),width:rect.width,height:rect.height};}));
  await page.locator('.performance-filters').screenshot({path:`test-results/dashboard-mobile-controls-${width}.png`});
  expect(sizes).toHaveLength(9);
  expect(sizes.filter(control=>control.width<240),`Narrow controls at ${width}px`).toEqual([]);
  expect(sizes.filter(control=>control.height<44),`Small touch targets at ${width}px`).toEqual([]);
  const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();expect(audit.violations.map(violation=>violation.id)).toEqual([]);
  await page.getByLabel('Desde',{exact:true}).fill('2026-09-01');await page.getByLabel('Hasta',{exact:true}).fill('2026-09-08');await page.getByLabel('Producto promocionado',{exact:true}).selectOption('campaign-name:costura que vende');
  await expect(page.getByLabel('Desde',{exact:true})).toHaveValue('2026-09-01');await expect(page.getByLabel('Producto promocionado',{exact:true})).toHaveValue('campaign-name:costura que vende');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }
});

// Unlike the visual fixture, this source responds to the requested period and
// tax basis. The only observed ad spend is on September 1, outside the initial
// seven-day window; expanding the range needs a separate coverage request.
function filterReport(url:URL,complete=true,configuredTaxBps?:number){
 const filters=Object.fromEntries(url.searchParams),from=filters.from!,to=filters.to!;
 const dates=Array.from({length:(Date.parse(to)-Date.parse(from))/86400000+1},(_,i)=>new Date(Date.parse(from)+i*86400000).toISOString().slice(0,10));
 const missingDays=complete?[]:dates.slice(0,-7),taxRequested=filters.cost_basis==='estimated_tax';
 const fallback=filters.fallback_tax_bps===undefined?null:Number(filters.fallback_tax_bps),taxBps=configuredTaxBps??fallback;
 const taxMissing=taxRequested&&taxBps===null,available=complete&&!taxMissing;
 const net=dates.includes('2026-09-01')?47958:0,spend=available?(taxRequested?Math.round(net*(10000+taxBps!)/10000):net):null;
 const value={...metric,spend_minor:spend,net_spend_observed_minor:net,cpa_minor:spend===null?null:spend/8,roas:spend?100000/spend:null,balance_minor:spend===null?null:125000-spend};
 const source=report();
 return {...source,environment:'REAL',filters,summary:value,
  series:dates.map(day=>{const covered=!missingDays.includes(day),dailyNet=day==='2026-09-01'?47958:0,dailySpend=covered&&!taxMissing?(taxRequested?Math.round(dailyNet*(10000+taxBps!)/10000):dailyNet):null;return{...value,day,spend_minor:dailySpend,net_spend_observed_minor:dailyNet,revenue_minor:day===to?125000:0,complete:covered,coverage_days_count:covered?1:0,days:1};}),
  groups:{products:[{...value,id:'campaign-name:costura que vende',name:'Costura que Vende',source:'CAMPAIGN_NAME',extracted_product:'costura que vende',product_id:null}],campaigns:[value],ads:[value]},
  quality:{...source.quality,status:complete?'SYNCED':'PARTIAL',available,complete,tax_missing:taxMissing,coverage_days_count:dates.length-missingDays.length,observed_days_count:dates.length-missingDays.length,missing_days:missingDays,blockers:[...(!complete?['INCOMPLETE_COVERAGE']:[]),...(taxMissing?['TAX_RATE_MISSING']:[])],tax_status:!taxRequested?'NOT_REQUESTED':taxMissing?'MISSING':configuredTaxBps===undefined?'ESTIMATED':'CONFIGURED',tax_estimate:{fallback_bps:fallback,applied_accounts:taxRequested&&configuredTaxBps===undefined&&fallback!==null?['act_demo']:[]},accounts:[{...source.quality.accounts[0],currency:filters.currency,covered_days:dates.length-missingDays.length,tax_bps:configuredTaxBps??null}]},
  revision:JSON.stringify([filters,complete,configuredTaxBps]),
 };
}
function watchFilterTraffic(page:Page){
 const reads:URL[]=[],writes:{path:string;body:Record<string,unknown>}[]=[];
 page.on('request',request=>{const url=new URL(request.url());if(!url.pathname.startsWith('/v1/'))return;if(request.method()!=='GET')writes.push({path:url.pathname,body:request.postDataJSON()});else if(url.pathname==='/v1/reports/campaign-performance')reads.push(url);});
 return{reads,writes};
}
const campaignKpi=(page:Page,label:string)=>page.locator('.performance-kpi').filter({has:page.getByText(label,{exact:true})}).locator('.kpi-value');
async function openFilterDashboard(page:Page){
 await page.goto('/campaigns');await expect(page.getByRole('heading',{name:'Campañas',exact:true})).toBeVisible();
 await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$0.00');
}

test('expanding seven to thirty days syncs once and tax estimates change the displayed amounts without new jobs',async({page})=>{
 await page.clock.install({time:new Date('2026-09-08T17:00:00Z')});await closureFixture(page);const traffic=watchFilterTraffic(page);
 const job='44444444-4444-4444-8444-444444444444';let covered=false,statusReads=0;
 await page.route('**/v1/reports/campaign-performance?**',route=>{const url=new URL(route.request().url()),expanded=url.searchParams.get('from')==='2026-08-10';return route.fulfill({json:{data:filterReport(url,!expanded||covered)}});});
 await page.route('**/v1/meta/insights/sync?**',route=>route.fulfill({status:202,json:{data:{id:job,status:'PENDING'}}}));
 await page.route('**/v1/meta/insights/status?**',route=>{const url=new URL(route.request().url());expect(url.searchParams.get('job_id')).toBe(job);expect(url.searchParams.get('environment')).toBe('REAL');statusReads++;covered=statusReads>=2;return route.fulfill({json:{data:[{id:job,status:covered?'SYNCED':'RUNNING'}]}});});
 await openFilterDashboard(page);expect(traffic.writes).toEqual([]);
 await page.getByLabel('Periodo',{exact:true}).selectOption('30');await expect.poll(()=>traffic.writes.length).toBe(1);await expect.poll(()=>statusReads).toBe(1);
 expect(traffic.writes[0]).toEqual({path:'/v1/meta/insights/sync',body:{environment:'REAL',from:'2026-08-10',to:'2026-09-08',recurring:false,preserve_schedule:true}});
 await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('No disponible');await expect(page.getByText('Gasto sin impuestos disponible',{exact:false})).toBeVisible();
 await page.clock.fastForward(3100);await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$479.58');expect(traffic.reads).toHaveLength(3);
 await page.getByLabel('Base de gasto',{exact:true}).selectOption('estimated_tax');await expect(page.getByLabel('Tasa estimada (%)',{exact:true})).toHaveValue('16');await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$556.31');
 expect(traffic.reads.at(-1)!.searchParams.get('fallback_tax_bps')).toBe('1600');await expect(campaignKpi(page,'Ingresos')).toHaveText('$1,250.00');
 await page.getByLabel('Tasa estimada (%)',{exact:true}).fill('10');await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$527.54');expect(traffic.reads.at(-1)!.searchParams.get('fallback_tax_bps')).toBe('1000');
 await page.getByLabel('Producto promocionado',{exact:true}).selectOption('campaign-name:costura que vende');await expect.poll(()=>traffic.reads.at(-1)?.searchParams.get('extracted_product')).toBe('costura que vende');
 await page.getByRole('combobox',{name:'Agrupar gráfica',exact:true}).selectOption('week');await expect.poll(()=>traffic.reads.at(-1)?.searchParams.get('granularity')).toBe('week');
 await page.getByLabel('Base de gasto',{exact:true}).selectOption('net');await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$479.58');
 await page.clock.fastForward(65000);expect(traffic.writes).toHaveLength(1);expect(statusReads).toBe(2);expect(traffic.reads.every(url=>url.searchParams.get('environment')==='REAL')).toBe(true);
});

test('partial coverage keeps observed spend visible and a refused automatic sync does not loop on presentation changes',async({page})=>{
 await page.clock.install({time:new Date('2026-09-08T17:00:00Z')});await closureFixture(page);const traffic=watchFilterTraffic(page);
 await page.route('**/v1/reports/campaign-performance?**',route=>{const url=new URL(route.request().url());return route.fulfill({json:{data:filterReport(url,url.searchParams.get('from')!=='2026-08-10')}});});
 await page.route('**/v1/meta/insights/sync?**',route=>route.fulfill({status:429,headers:{'Retry-After':'60'},json:{error:{code:'RATE_LIMITED'}}}));
 await openFilterDashboard(page);await page.getByLabel('Periodo',{exact:true}).selectOption('30');await expect.poll(()=>traffic.writes.length).toBe(1);
 expect(traffic.writes[0]).toEqual({path:'/v1/meta/insights/sync',body:{environment:'REAL',from:'2026-08-10',to:'2026-09-08',recurring:false,preserve_schedule:true}});
 await expect(page.getByText('Gasto sin impuestos disponible',{exact:false})).toBeVisible();await expect(page.getByText('$479.58',{exact:false}).first()).toBeVisible();
 await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('No disponible');await expect(campaignKpi(page,'ROAS atribuido')).toHaveText('No disponible');await expect(campaignKpi(page,'Ingresos')).toHaveText('$1,250.00');await expect(page.getByText('Periodo cubierto',{exact:false})).toHaveCount(0);
 await expect(page.getByText('Hay demasiadas solicitudes.',{exact:false}).first()).toBeVisible();
 await page.getByLabel('Base de gasto',{exact:true}).selectOption('estimated_tax');await expect.poll(()=>traffic.reads.at(-1)?.searchParams.get('cost_basis')).toBe('estimated_tax');
 await page.getByLabel('Producto promocionado',{exact:true}).selectOption('campaign-name:costura que vende');await expect.poll(()=>traffic.reads.at(-1)?.searchParams.get('extracted_product')).toBe('costura que vende');
 await page.getByRole('combobox',{name:'Agrupar gráfica',exact:true}).selectOption('week');await expect.poll(()=>traffic.reads.at(-1)?.searchParams.get('granularity')).toBe('week');
 const reads=traffic.reads.length;await page.clock.fastForward(65000);expect(traffic.reads).toHaveLength(reads);expect(traffic.writes).toHaveLength(1);
});

test('a delayed or failed new filter preserves the prior cut with its original dates and net basis',async({page})=>{
 await page.clock.install({time:new Date('2026-09-08T17:00:00Z')});await closureFixture(page);const traffic=watchFilterTraffic(page);
 let release!:()=>void,delayed=false;const wait=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/v1/reports/campaign-performance?**',async route=>{
  const url=new URL(route.request().url());if(url.searchParams.get('from')!=='2026-08-10')return route.fulfill({json:{data:filterReport(url)}});
  if(!delayed){delayed=true;await wait;}
  await route.fulfill({status:429,headers:{'Retry-After':'60'},json:{error:{code:'RATE_LIMITED'}}});
 });
 try{
  await openFilterDashboard(page);await page.getByLabel('Periodo',{exact:true}).selectOption('30');await expect.poll(()=>delayed).toBe(true);
  const balance=page.getByRole('region',{name:'Balance publicitario del periodo'});
  await expect(page.getByText('Mostrando el último corte',{exact:false})).toBeVisible();await expect(balance).toContainText('2026-09-02');await expect(balance).not.toContainText('2026-08-10');await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$0.00');
  release();await expect(page.getByText('Hay demasiadas solicitudes.',{exact:false}).first()).toBeVisible();await expect(campaignKpi(page,'Ingresos')).toHaveText('$1,250.00');
  await page.getByLabel('Base de gasto',{exact:true}).selectOption('estimated_tax');await expect.poll(()=>traffic.reads.length).toBe(3);
  await expect(balance).toContainText('Gasto Meta sin impuestos');await expect(balance).not.toContainText('Gasto Meta con impuestos');await expect(balance).toContainText('2026-09-02');await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$0.00');
  await page.clock.fastForward(65000);expect(traffic.reads).toHaveLength(3);expect(traffic.writes).toEqual([]);
 }finally{release();}
});

test('non-MXN tax estimates require an explicit rate and a configured account rate takes precedence',async({page})=>{
 await page.clock.install({time:new Date('2026-09-08T17:00:00Z')});await closureFixture(page);const traffic=watchFilterTraffic(page);
 await page.route('**/v1/reports/campaign-performance?**',route=>{const url=new URL(route.request().url());return route.fulfill({json:{data:filterReport(url,true,url.searchParams.get('meta_ad_account_id')==='act_demo'?800:undefined)}});});
 await openFilterDashboard(page);await page.getByLabel('Periodo',{exact:true}).selectOption('30');await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$479.58');
 await page.getByLabel('Base de gasto',{exact:true}).selectOption('estimated_tax');await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$556.31');
 await page.getByLabel('Cuenta publicitaria',{exact:true}).selectOption('act_demo');await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('$517.95');expect(traffic.reads.at(-1)!.searchParams.get('fallback_tax_bps')).toBe('1600');
 await page.getByLabel('Cuenta publicitaria',{exact:true}).selectOption('');await page.getByLabel('Moneda',{exact:true}).selectOption('USD');await expect(page.getByLabel('Tasa estimada (%)',{exact:true})).toHaveValue('');
 await expect(campaignKpi(page,'Gasto publicitario')).toHaveText('No disponible');expect(traffic.reads.at(-1)!.searchParams.has('fallback_tax_bps')).toBe(false);await expect(page.getByText(/Falta.*tasa|Indica.*tasa|elige.*tasa/i).first()).toBeVisible();
 expect(traffic.writes).toEqual([]);
});

test('sales keep the visible report currency through a delayed failure and switch only after the new report succeeds',async({page})=>{
 await page.clock.install({time:new Date('2026-09-08T17:00:00Z')});await closureFixture(page);const traffic=watchFilterTraffic(page),salesReads:URL[]=[];
 let release!:()=>void,usdReports=0,usdReportReady=false;const wait=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/v1/reports/campaign-performance?**',async route=>{
  const url=new URL(route.request().url()),usd=url.searchParams.get('currency')==='USD';
  if(usd&&++usdReports===1){await wait;return route.fulfill({status:429,headers:{'Retry-After':'60'},json:{error:{code:'RATE_LIMITED'}}});}
  const data=filterReport(url);if(usd){data.summary.revenue_minor=25000;data.summary.balance_minor=25000;usdReportReady=true;}
  return route.fulfill({json:{data}});
 });
 await page.route('**/v1/reports/campaign-sales?**',route=>{
  const url=new URL(route.request().url()),usd=url.searchParams.get('currency')==='USD';salesReads.push(url);
  if(usd)expect(usdReportReady,'USD sales must wait for a successful USD report').toBe(true);
  return route.fulfill({json:{data:[{order_id:usd?'order-usd':'order-mxn',sold_product_id:product.id,amount_minor:usd?25000:125000,currency:usd?'USD':'MXN',effective_at:'2026-09-08T16:00:00Z',campaign_name:usd?'Venta en dólares':'Venta en pesos',classifications:['VALID']}],meta:{total:1}}});
 });
 try{
  await openFilterDashboard(page);await page.getByRole('button',{name:'Ventas',exact:true}).click();
  const table=page.locator('.performance-table'),meta=page.locator('.performance-meta');
  await expect(table).toContainText('Venta en pesos');await expect(table).toContainText('$1,250.00');await expect(meta).toContainText('MXN');expect(salesReads).toHaveLength(1);
  await page.getByLabel('Moneda',{exact:true}).selectOption('USD');await expect.poll(()=>usdReports).toBe(1);
  await expect(page.getByText('Mostrando el último corte',{exact:false})).toBeVisible();await expect(table).toContainText('Venta en pesos');await expect(table).toContainText('$1,250.00');await expect(meta).toContainText('MXN');expect(salesReads).toHaveLength(1);
  release();await expect(page.getByText('Hay demasiadas solicitudes.',{exact:false}).first()).toBeVisible();
  await expect(table).toContainText('Venta en pesos');await expect(table).not.toContainText('Venta en dólares');await expect(meta).toContainText('MXN');expect(salesReads).toHaveLength(1);
  // A deliberate change away and back retries the failed selection, without a Meta write.
  await page.getByLabel('Moneda',{exact:true}).selectOption('MXN');await expect(page.getByText('Mostrando el último corte',{exact:false})).toHaveCount(0);
  await page.getByLabel('Moneda',{exact:true}).selectOption('USD');await expect(table).toContainText('Venta en dólares');
  await expect(table).toContainText(new Intl.NumberFormat('es-MX',{style:'currency',currency:'USD'}).format(250));await expect(table).not.toContainText('Venta en pesos');await expect(meta).toContainText('USD');await expect(meta).not.toContainText('MXN');
  expect(salesReads.map(url=>url.searchParams.get('currency'))).toEqual(['MXN','USD']);expect(salesReads.every(url=>url.searchParams.get('environment')==='REAL')).toBe(true);expect(traffic.writes).toEqual([]);
 }finally{release();}
});
