import {expect,test} from '@playwright/test';

test('the mobile order slip shows both destinations on opening and copies their exact digits',async({page,context,baseURL})=>{
 const clabe='000000000000003866',card='0000000000000321',holder='Persona de prueba';
 await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(baseURL!).origin});
 await page.setViewportSize({width:320,height:680});
 let reads=0;
 await page.route('**/v2/customer/spin-deposit',async route=>{
  expect(route.request().method()).toBe('POST');
  expect(route.request().postDataJSON()).toEqual({token:'prueba'});
  reads++;
  await route.fulfill({json:{product_name:'Producto de prueba',spin:{card_number:card,holder},spei:{bank:'FINCO PAY',clabe,holder}}});
 });
 await page.goto('/deposito-spin.html#prueba');
 await expect(page.getByText('FINCO PAY (ARQ)')).toBeVisible();
 await expect(page.getByText(holder,{exact:true})).toBeVisible();
 expect(reads).toBe(1);
 await expect(page.getByLabel('CLABE',{exact:true})).toHaveValue(clabe);
 await expect(page.getByLabel('Tarjeta Spin by OXXO')).toHaveValue(card);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 for(const [name,value] of [['Copiar CLABE',clabe],['Copiar tarjeta',card]] as const){
  await page.getByRole('button',{name}).click();
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(value);
 }
});
