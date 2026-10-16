/** Ventas sub-navigation (RF-17.a: one main section, four views). */
const views=[['conversations','/sales/inbox','Conversaciones'],['orders','/sales/orders','Pedidos'],['receipts','/sales/receipts','Comprobantes'],['payments','/sales/payments','Pagos']] as const;
export type SalesView=typeof views[number][0];
export function SalesNav({current}:{current:SalesView}){
 return <nav aria-label="Ventas" className="receipt-subnav">{views.map(([key,href,label])=><a key={key} href={href} aria-current={key===current?'page':undefined}>{label}</a>)}</nav>;
}
