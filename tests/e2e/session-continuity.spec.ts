import {test,expect} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';
test('number controls, principal form and recovery are accessible at mobile and desktop sizes',async({page})=>{
 const account={id:'11111111-1111-4111-8111-111111111111',name:'Número de continuidad',provider:'waha',status:'STOPPED',version:1,sending_enabled:false};
 let revision=1,used:string|null=null;const writes:Record<string,unknown>[]=[];
 await page.route('**/v1/**',async route=>{const r=route.request(),path=new URL(r.url()).pathname;let data:unknown=[];
 if(path==='/v1/me')data={user:{id:'operator',name:'Operador',email:'fixture@example.invalid'},workspace_id:'fixture-continuity',role:'owner',permissions:['*'],environment:'REAL'};
 else if(path==='/v1/channel-accounts')data=[account];
 else if(path==='/v1/users')data=[{id:'operator',name:'Operador'}];
 else if(path.endsWith('/session'))data={id:'session',revision,observed_state:'UNKNOWN',health_fresh:false,primary_last_used_at:used,primary_usage_source:used?'operator_confirmation':null,maintenance:{status:used?'CURRENT':'UNKNOWN'},recovery_enabled:false,operational_pause:true,desired_state:'STOPPED',retry_count:0,recovery_stage:'NONE',inventory:{},history:[],alerts:[],uncertain_commands:[],sending_enabled:false};
 else if(path.endsWith('/commands'))data={id:'22222222-2222-4222-8222-222222222222',status:'PENDING'};
 else if(path.startsWith('/v1/commands/'))data={id:'22222222-2222-4222-8222-222222222222',status:'APPLIED',result:{status:'CHECKED'}};
 else if(path.endsWith('/primary-usage')){const body=r.postDataJSON();writes.push(body);used=body.used_at;revision++;data={revision};}
 else if(path.endsWith('/health'))data={state:'BLOCKED',reason:'UNKNOWN',next_action:'Revisar conexión',observations:[],official_quality:{availability:'not_available',value:null},capabilities:{},statistics:[]};
 await route.fulfill({json:{data}});
 });
 for(const width of [320,1440]){
 await page.setViewportSize({width,height:1000});await page.goto('/settings/channels/advanced');const card=page.getByRole('button',{name:/Número de continuidad/});await card.click();const detail=page.getByRole('dialog',{name:'Número de continuidad',exact:true});
 await expect(detail.getByRole('button',{name:'Conectar',exact:true})).toBeVisible();await expect(detail.getByText('Deshabilitados',{exact:true})).toBeVisible();expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
 await detail.getByRole('button',{name:'Revisar salud',exact:true}).click();await expect(detail.getByText('Operación completada.',{exact:true})).toBeVisible();
 await detail.getByRole('button',{name:'Teléfono principal',exact:true}).click();await detail.getByRole('button',{name:'Registrar uso del principal',exact:true}).click();const form=page.getByRole('dialog',{name:'Registrar uso del principal',exact:true});await form.getByLabel('Fecha y hora del uso real').fill('2026-09-15T08:00');await form.getByLabel('Motivo o evidencia').fill('Abrí la aplicación en el principal de prueba');expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.screenshot({path:`test-results/session-primary-${width}.png`});await form.getByRole('button',{name:'Guardar',exact:true}).click();await expect(form).toBeHidden();
 await detail.getByRole('button',{name:'Recuperación',exact:true}).click();await expect(detail.getByText('Desactivada',{exact:true})).toBeVisible();expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.screenshot({path:`test-results/session-recovery-${width}.png`});
 expect(await detail.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.keyboard.press('Escape');await expect(detail).toBeHidden();await expect(card).toBeFocused();
 }
 expect(writes).toHaveLength(2);expect(writes.every(b=>b.source==='operator_confirmation'&&b.environment==='REAL'&&Number(b.expected_version)>0)).toBe(true);
});
