import {test,expect} from '@playwright/test';
import {closureFixture} from './support/closure-fixture.js';

test('owner can pause during a release and reopen with verified per-number readback',async({page})=>{
 await closureFixture(page);
 const actions:string[]=[];
 const status={configuration_version:7,release_hold:true,policy_open:false,workspace_paused:false,observed_at:new Date().toISOString(),summary:{operating:0,attention:1,blocked:0},numbers:[{id:'account-fixture',alias:'•••• 8571',status:'NECESITA_ATENCION',reason_code:'RELEASE_HOLD',authorization_expires_at:'2026-09-24T00:00:00.000Z',authorization_scopes:[{assignment_id:'assignment-fixture',recipient_mode:'new_inbound',max_messages:250,allow_automation:true,expires_at:'2026-09-24T00:00:00.000Z'}],authorization_expiring_soon:true,unknown_effects:0,blocked_effects:0,next_action:{label:'Revisar número'}}]};
 await page.route('**/v1/settings/launch**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname;
  if(path==='/v1/settings/launch/switch'){
   const body=request.postDataJSON();actions.push(body.action);
   expect(request.headers()['idempotency-key']).toBeTruthy();
   expect(body).toMatchObject({environment:'REAL',expected_version:7,confirmation:'CONFIRM_REAL_SWITCH'});
   status.workspace_paused=body.action==='PAUSE';status.release_hold=false;status.policy_open=true;
   status.summary={operating:body.action==='OPEN'?1:0,attention:body.action==='PAUSE'?1:0,blocked:0};
   status.numbers[0]!.status=body.action==='OPEN'?'OPERANDO':'NECESITA_ATENCION';
   await route.fulfill({json:{data:{action:body.action,configuration_version:7,authorization_renewed:false,readback:status}}});return;
  }
  await route.fulfill({json:{data:status}});
 });
 await page.goto('/settings');
 await expect(page.getByText('Publicación en curso')).toBeVisible();
 await expect(page.getByText(/Sólo entradas nuevas · máx. 250/)).toBeVisible();
 const reason=page.getByPlaceholder('Motivo de la apertura o pausa');
 const confirmation=page.getByRole('checkbox',{name:/Confirmo el cambio de operación REAL/});
 await reason.fill('Pausa de emergencia durante publicación');await confirmation.check();
 await page.getByRole('button',{name:'Pausar ventas'}).click();
 await expect(page.getByText('Ventas pausadas y estado verificado.')).toBeVisible();
 await reason.fill('Reanudar alcance vigente');await confirmation.check();
 await page.getByRole('button',{name:'Abrir ventas'}).click();
 await expect(page.getByText(/REAL abierto\. 1 números operando/)).toBeVisible();
 expect(actions).toEqual(['PAUSE','OPEN']);
});
