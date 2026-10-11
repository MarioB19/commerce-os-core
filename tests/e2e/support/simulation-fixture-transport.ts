import {expect,type Page,type APIRequestContext} from '@playwright/test';
/** Legacy UI regression fixtures live in SIMULATION in the isolated test DB.
 * The browser still asserts the production REAL contract. Only this test
 * transport maps requests to those fixtures; it is never loaded by the app.
 * Default/laboratory contract tests must never install this adapter.
 */
export function simulationUrl(path:string) {
 if(!path.includes('/v1/'))return path;
 const [base,query]=path.split('?');const search=new URLSearchParams(query);
 if(!search.has('environment'))search.set('environment','SIMULATION');
 return `${base}?${search}`;
}
export function fixtureRequest(page:{request:APIRequestContext}):APIRequestContext {
 return new Proxy(page.request,{get(target,key){
  const original=Reflect.get(target,key);
  if(typeof original!=='function')return original;
  if(!['get','post','put','patch','delete','head','fetch'].includes(String(key)))return original.bind(target);
  return (url:string,options:Record<string,unknown>={})=>{
   const body=options.data;
   const env=body&&typeof body==='object'&&!Array.isArray(body)?(body as Record<string,unknown>).environment:undefined;
   const path=typeof env==='string'&&url.includes('/v1/')&&!url.includes('environment=')?url+(url.includes('?')?'&':'?')+'environment='+env:simulationUrl(url);
   return original.call(target,path,options);
  };
 }});
}
export async function useSimulationFixtureTransport(page:Page) {
 const handler=async(route:import('@playwright/test').Route)=>{
  const req=route.request(),url=new URL(req.url());
  if(url.pathname==='/v1/me'||url.pathname.startsWith('/v1/identity/'))return route.fallback();
  expect(url.searchParams.get('environment'),'Browser explicitly declares its real or laboratory context').toMatch(/^(REAL|SIMULATION)$/);
  // Launch status has no SIMULATION contract. Preserve this fixed REAL read;
  // switches and every other fixture request still stay in SIMULATION.
  if(req.method()==='GET'&&url.pathname==='/v1/settings/launch'&&url.searchParams.get('environment')==='REAL')return route.fallback();
  url.searchParams.set('environment','SIMULATION');
  const raw=req.postData();let postData=raw??undefined;
  if(raw&&req.headers()['content-type']?.includes('application/json'))postData=JSON.stringify({...req.postDataJSON(),environment:'SIMULATION'});
  // Rewrite the original browser request, preserving its abort/lifecycle. A
  // detached fetch + fulfill can outlive route removal and attempt a second
  // response after Playwright has already continued the intercepted request.
  await route.continue({url:url.href,...(postData===undefined?{}:{postData})});
 };
 await page.route('**/v1/**',handler);
 return ()=>page.unroute('**/v1/**',handler);
}
