/** V7 (RF-17.a): the six destinations of a profile, identical on desktop and
 * mobile; configuration lives in the account menu. Routes do not change. */
export const profileApplicationPaths=['/','/home','/login','/products','/sales/inbox','/sales/orders','/sales/receipts','/sales/payments','/sales/payments/rules','/results','/results/goals','/settings/profile','/settings/employees','/account/integrations','/numbers','/account/tokens','/account/security','/campaigns','/help'] as const;
const uuidPattern='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const productPath=new RegExp(`^/products/(${uuidPattern})(?:/variants)?$`,'i');
export const variantEditorPath=new RegExp(`^/products/(${uuidPattern})/variants/(${uuidPattern})(?:/(sale|offer|collection|remarketing|numbers))?$`,'i');
export const numberTestPath=new RegExp(`^/numbers/(${uuidPattern})/test$`,'i');
const productVariantPath={test:(path:string)=>productPath.test(path)||variantEditorPath.test(path)};
export const profileSections=[
 {label:'Inicio',href:'/home',active:(path:string)=>['/','/home','/login'].includes(path)},
 {label:'Productos',href:'/products',active:(path:string)=>path==='/products'||productVariantPath.test(path)},
 {label:'Ventas',href:'/sales/inbox',active:(path:string)=>path.startsWith('/sales/')},
 {label:'Números',href:'/numbers',active:(path:string)=>path==='/numbers'||numberTestPath.test(path)},
 {label:'Campañas',href:'/campaigns',active:(path:string)=>path==='/campaigns'},
 {label:'Resultados',href:'/results',active:(path:string)=>path.startsWith('/results')},
] as const;
export const isProfileApplicationPath=(path:string)=>profileApplicationPaths.some(value=>value===path)||productVariantPath.test(path)||numberTestPath.test(path);
