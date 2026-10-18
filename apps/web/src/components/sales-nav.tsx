import {LinkTabs} from './ui';
/** Ventas sub-navigation (RF-17.a: one main section, four views). */
const views=[['conversations','/sales/inbox','Conversaciones'],['orders','/sales/orders','Pedidos'],['receipts','/sales/receipts','Comprobantes'],['payments','/sales/payments','Pagos']] as const;
export type SalesView=typeof views[number][0];
export function SalesNav({current}:{current:SalesView}){
 return <LinkTabs label="Ventas" current={current} items={views.map(([key,href,label])=>({key,href,label}))}/>;
}
