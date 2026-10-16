/** V7 F8 (RF-17, Inventario y paridad V7 «Rutas web actuales»): addresses of
 * the previous application lead to their V7 equivalent; retired functions
 * (Inteligencia, estudio, archivo creativo) show that they were retired. */
export const legacyRedirects:Readonly<Record<string,string>>=Object.freeze({
 '/help/launch':'/help','/catalog':'/products','/sales':'/sales/inbox','/sales/leads':'/sales/inbox','/sales/campaigns':'/campaigns',
 '/sales/flows':'/products','/sales/agents':'/products','/sales/madrina':'/numbers','/sales/channels/whatsapp':'/numbers','/sales/warmups':'/numbers',
 '/sales/simulator':'/numbers','/sales/flows/simulator':'/numbers','/simulator':'/numbers','/settings/tests':'/numbers','/settings/warmup':'/numbers',
 '/settings/warmup/legacy':'/numbers','/settings/channels/advanced':'/numbers','/settings':'/settings/profile','/settings/integrations':'/account/integrations',
 '/settings/integrations/meta':'/account/integrations','/settings/integrations/acquisition':'/account/integrations','/campaigns/meta':'/account/integrations',
 '/settings/integrations/mail':'/platform',
});
const retired=[/^\/intelligence(?:\/|$)/,/^\/studio(?:\/|$)/,/^\/settings\/creative$/,/^\/archive\/materials$/];
export function legacyTarget(path:string):string|undefined{
 if(Object.hasOwn(legacyRedirects,path))return legacyRedirects[path];
 if(/^\/sales\/(?:flows|agents)\/[^/]+$/.test(path))return '/products';
 return undefined;
}
export const isRetiredPath=(path:string)=>retired.some(pattern=>pattern.test(path));
