import {expect,test,type Locator,type Page} from '@playwright/test';
import {closureFixture} from './support/closure-fixture.js';

type AxNode={
 ignored?:boolean;
 role?:{value?:unknown};
 name?:{value?:unknown};
 properties?:Array<{name:string;value?:{value?:unknown}}>;
};

type RouteCase={
 slug:string;
 path:string;
 heading:RegExp;
 primaryRole:string;
 primaryName:RegExp;
 primary:(page:Page)=>Locator;
};

const routes:RouteCase[]=[
 {slug:'home',path:'/home',heading:/Todo conectado/,primaryRole:'link',primaryName:/Abrir tarea/,primary:page=>page.getByRole('link',{name:/Abrir tarea/}).first()},
 {slug:'intelligence',path:'/intelligence',heading:/^Inteligencia$/,primaryRole:'textbox',primaryName:/Palabras o nicho/,primary:page=>page.getByRole('textbox',{name:'Palabras o nicho'}).first()},
 {slug:'catalog',path:'/catalog',heading:/^Productos y ofertas$/,primaryRole:'button',primaryName:/Producto de demostración/,primary:page=>page.getByRole('button',{name:/Producto de demostración/}).first()},
 {slug:'campaigns',path:'/campaigns',heading:/^Campañas$/,primaryRole:'combobox',primaryName:/Periodo/,primary:page=>page.getByRole('combobox',{name:'Periodo',exact:true}).first()},
 {slug:'sales',path:'/sales',heading:/Tu operación de ventas/,primaryRole:'link',primaryName:/^Conversaciones/,primary:page=>page.getByRole('link',{name:/^Conversaciones/}).first()},
 {slug:'results',path:'/results',heading:/Hechos para decidir mejor/,primaryRole:'combobox',primaryName:/Agrupar por/,primary:page=>page.getByRole('combobox',{name:'Agrupar por'}).first()},
 {slug:'settings',path:'/settings',heading:/Configuración de tu operación/,primaryRole:'link',primaryName:/^Auditoría$/,primary:page=>page.getByRole('link',{name:'Auditoría',exact:true}).first()},
];

function axValue(node:AxNode,key:'role'|'name'){
 return String(node[key]?.value??'');
}

async function assertAccessibilityTree(page:Page,route:RouteCase){
 const session=await page.context().newCDPSession(page);
 try{
  const snapshot=await session.send('Accessibility.getFullAXTree');
  const nodes=snapshot.nodes as AxNode[];
  expect(nodes.some(node=>!node.ignored&&axValue(node,'role')==='main'),`${route.slug}: main in Chromium AX tree`).toBe(true);
  expect(nodes.some(node=>!node.ignored&&axValue(node,'role')==='navigation'&&axValue(node,'name')==='Navegación principal'),`${route.slug}: named navigation in Chromium AX tree`).toBe(true);
  expect(nodes.some(node=>{
   const level=node.properties?.find(property=>property.name==='level')?.value?.value;
   return !node.ignored&&axValue(node,'role')==='heading'&&Number(level)===1&&route.heading.test(axValue(node,'name'));
  }),`${route.slug}: named H1 in Chromium AX tree`).toBe(true);
  expect(nodes.some(node=>!node.ignored&&axValue(node,'role')===route.primaryRole&&route.primaryName.test(axValue(node,'name'))),`${route.slug}: named primary task in Chromium AX tree`).toBe(true);
 }finally{
  await session.detach();
 }
}

async function assertReflow(page:Page,route:RouteCase,width:number){
 await page.setViewportSize({width,height:1000});
 await page.goto(route.path);
 await expect(page.getByRole('heading',{level:1,name:route.heading})).toBeVisible();
 await expect(route.primary(page)).toBeVisible();
 const reflow=await page.evaluate(()=>({
  viewport:window.innerWidth,
 document:document.documentElement.scrollWidth,
 mainClient:document.querySelector('main')?.clientWidth??0,
 mainScroll:document.querySelector('main')?.scrollWidth??0,
  offenders:[...document.querySelectorAll<HTMLElement>('body *')].filter(element=>{
   const rect=element.getBoundingClientRect();
   return rect.right>window.innerWidth+1||rect.left<-1;
  }).slice(0,8).map(element=>({tag:element.tagName,className:element.className,width:element.getBoundingClientRect().width,scrollWidth:element.scrollWidth})),
 }));
 expect(reflow.document,`${route.slug}: document reflow at ${width}px; offenders=${JSON.stringify(reflow.offenders)}`).toBeLessThanOrEqual(reflow.viewport+1);
 expect(reflow.mainScroll,`${route.slug}: main reflow at ${width}px; offenders=${JSON.stringify(reflow.offenders)}`).toBeLessThanOrEqual(reflow.mainClient+1);
}

async function assertReducedMotion(page:Page,route:RouteCase){
 const reduced=await page.evaluate(()=>{
  const sheet=document.createElement('style');
  sheet.textContent='@keyframes commerce-a11y-probe{from{opacity:.5}to{opacity:1}}';
  const probe=document.createElement('div');
  probe.style.animation='commerce-a11y-probe 2s linear infinite';
  probe.style.transition='transform 2s linear';
  document.head.append(sheet);
  document.body.append(probe);
  const computed=getComputedStyle(probe);
  const result={
   mediaMatches:matchMedia('(prefers-reduced-motion: reduce)').matches,
   animationName:computed.animationName,
   transitionDuration:computed.transitionDuration,
   scrollBehavior:getComputedStyle(document.documentElement).scrollBehavior,
  };
  probe.remove();sheet.remove();
  return result;
 });
 expect(reduced.mediaMatches,`${route.slug}: reduced-motion media query`).toBe(true);
 expect(reduced.animationName,`${route.slug}: animations disabled`).toBe('none');
 expect(reduced.transitionDuration,`${route.slug}: transitions disabled`).toBe('0s');
 expect(reduced.scrollBehavior,`${route.slug}: smooth scrolling disabled`).toBe('auto');
}

async function assertKeyboardAndVisibleFocus(page:Page,route:RouteCase){
 await page.goto(route.path);
 await expect(page.getByRole('heading',{level:1,name:route.heading})).toBeVisible();
 const primary=route.primary(page);
 await expect(primary).toBeVisible();

 await page.keyboard.press('Tab');
 const skip=page.getByRole('link',{name:'Saltar al contenido'});
 await expect(skip).toBeFocused();
 const skipFocus=await skip.evaluate(element=>{
  const style=getComputedStyle(element);
  return {outlineStyle:style.outlineStyle,outlineWidth:Number.parseFloat(style.outlineWidth),width:element.getBoundingClientRect().width,height:element.getBoundingClientRect().height};
 });
 expect(skipFocus.outlineStyle).not.toBe('none');
 expect(skipFocus.outlineWidth).toBeGreaterThanOrEqual(2);
 expect(skipFocus.width).toBeGreaterThan(0);
 expect(skipFocus.height).toBeGreaterThan(0);

 await page.keyboard.press('Enter');
 await expect(page.getByRole('main')).toBeFocused();
 let reached=false;
 for(let step=0;step<80;step++){
  await page.keyboard.press('Tab');
  if(await primary.evaluate(element=>document.activeElement===element)){
   reached=true;
   break;
  }
 }
 expect(reached,`${route.slug}: primary task reachable by keyboard`).toBe(true);
 const primaryFocus=await primary.evaluate(element=>{
  const style=getComputedStyle(element);
  const rect=element.getBoundingClientRect();
  return {outlineStyle:style.outlineStyle,outlineWidth:Number.parseFloat(style.outlineWidth),visible:rect.bottom>0&&rect.top<window.innerHeight&&rect.right>0&&rect.left<window.innerWidth};
 });
 expect(primaryFocus.outlineStyle,`${route.slug}: primary focus outline style`).not.toBe('none');
 expect(primaryFocus.outlineWidth,`${route.slug}: primary focus outline width`).toBeGreaterThanOrEqual(2);
 expect(primaryFocus.visible,`${route.slug}: focused task visible in viewport`).toBe(true);
}

test.describe('resilience accessibility evidence gate',()=>{
 for(const route of routes)test(`${route.slug}: reflow, reduced motion, AX semantics and keyboard focus`,async({page},testInfo)=>{
  const requests=await closureFixture(page);
  const externalRequests:string[]=[];
  const baseOrigin=new URL(String(testInfo.project.use.baseURL)).origin;
  page.on('request',request=>{
   const target=new URL(request.url());
   if(/^https?:$/.test(target.protocol)&&target.origin!==baseOrigin)externalRequests.push(target.origin);
  });
  await page.emulateMedia({reducedMotion:'reduce'});

  // 1280 CSS px at 200% and 400% maps to 640 and 320 CSS px respectively.
  await assertReflow(page,route,640);
  await assertReflow(page,route,320);

  await page.setViewportSize({width:1280,height:1000});
  await page.goto(route.path);
  await expect(page.getByRole('heading',{level:1,name:route.heading})).toBeVisible();
  await expect(route.primary(page)).toBeVisible();
  await assertReducedMotion(page,route);
  await assertAccessibilityTree(page,route);
  await assertKeyboardAndVisibleFocus(page,route);

  expect(requests.filter(request=>request.method!=='GET'),`${route.slug}: fixture journey stays GET-only`).toEqual([]);
  expect(externalRequests,`${route.slug}: no external or provider network`).toEqual([]);
 });
});
