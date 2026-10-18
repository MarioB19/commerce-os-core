import {test,expect,type Page} from '@playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import {provisionUser} from '../../apps/api/src/auth.js';

// V7 UI redesign (docs/ui-redesign-v7.md): a light visual-regression net over
// screens whose content does not depend on the profile's data. The baselines
// live next to this file (`v7-visual.spec.ts-snapshots/`) and are versioned:
// a missing baseline fails the run instead of being written into the checkout.
// Tolerance covers font hinting between machines; a real layout change shows
// as a clear diff in test-results/ and is accepted with `--update-snapshots`.
test.use({screenshot:'off',trace:'off',video:'off'});
const profile=process.env.WORKSPACE_ID??'local';
const options={animations:'disabled',caret:'hide',scale:'css',maxDiffPixelRatio:0.03,threshold:0.35} as const;
const mobile={width:375,height:812};

async function settle(page:Page){
 await page.waitForLoadState('networkidle');
 await page.evaluate(()=>document.fonts.ready);
}
async function signIn(page:Page){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({email,password,name:'Dueña de prueba',workspace_id:profile,role:'owner'});
 await page.goto('/login');
 await page.getByLabel('Correo electrónico').fill(email);await page.getByLabel('Contraseña',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Entrar a Commerce OS'}).click();
 const chooser=page.getByRole('heading',{name:'Tus perfiles'});
 await expect(page.getByRole('navigation',{name:'Navegación del perfil'}).or(chooser)).toBeVisible();
 if(await chooser.isVisible()){await page.getByLabel('Perfil',{exact:true}).selectOption(profile);await page.getByRole('button',{name:'Cambiar a este perfil'}).click();}
 await expect(page.getByRole('navigation',{name:'Navegación del perfil'})).toBeVisible();
}
// Shell regions fed by the profile's counters, alerts and goal vary between
// databases; the account card shows the random address of the test owner.
const dynamic=(page:Page)=>[page.locator('.nav-count'),page.locator('.sidebar-goal'),page.locator('.profile-switch'),
 page.getByRole('button',{name:/^Avisos/}),page.locator('#security-identity ~ p')];

test('login page keeps its layout on desktop and at 375 px',async({page})=>{
 await page.goto('/login');await settle(page);
 await expect(page).toHaveScreenshot('login-desktop.png',options);
 await page.setViewportSize(mobile);await settle(page);
 await expect(page).toHaveScreenshot('login-mobile.png',options);
});

test('shell, help and security keep their layout on desktop and at 375 px',async({page})=>{
 await signIn(page);
 await page.goto('/help');await settle(page);
 await expect(page.getByRole('heading',{level:1,name:'Ayuda'})).toBeVisible();
 await expect(page).toHaveScreenshot('help-desktop.png',{...options,mask:dynamic(page)});
 await page.goto('/account/security');await settle(page);
 await expect(page.getByRole('heading',{level:1,name:'Seguridad'})).toBeVisible();
 await expect(page).toHaveScreenshot('security-desktop.png',{...options,mask:dynamic(page)});
 await page.setViewportSize(mobile);
 await page.goto('/help');await settle(page);
 await expect(page.getByRole('heading',{level:1,name:'Ayuda'})).toBeVisible();
 await expect(page).toHaveScreenshot('help-mobile.png',{...options,mask:dynamic(page)});
});
