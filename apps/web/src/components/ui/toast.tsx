import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import {CircleCheck,CircleX,Info,X} from 'lucide-react';

export interface ToastInput {tone?:'success'|'error'|'info';title:string;description?:string;action?:{label:string;onClick:()=>void};duration?:number}
interface ToastItem extends ToastInput {id:number}
const ToastContext=React.createContext<(t:ToastInput)=>void>(()=>undefined);
/** Radix Toast (1.3.1): success and error with a recovery action. Errors stay
 * until dismissed; success leaves on its own. `role` comes from Radix
 * (`status` for the default type). */
export function ToastProvider({children}:{children:React.ReactNode}){
 const [items,setItems]=React.useState<ToastItem[]>([]),counter=React.useRef(0);
 const push=React.useCallback((t:ToastInput)=>{setItems(list=>[...list.slice(-3),{...t,id:++counter.current}]);},[]);
 return <ToastContext.Provider value={push}>
  <ToastPrimitive.Provider swipeDirection="right" label="Avisos">
   {children}
   {items.map(t=>{const Icon=t.tone==='error'?CircleX:t.tone==='info'?Info:CircleCheck;
    return <ToastPrimitive.Root key={t.id} className="toast" data-tone={t.tone??'success'} duration={t.duration??(t.tone==='error'?Infinity:6000)} type={t.tone==='error'?'foreground':'background'} onOpenChange={open=>{if(!open)setItems(list=>list.filter(x=>x.id!==t.id));}}>
     <Icon aria-hidden="true"/>
     <div className="toast-body"><ToastPrimitive.Title className="toast-title">{t.title}</ToastPrimitive.Title>{t.description&&<ToastPrimitive.Description className="toast-description">{t.description}</ToastPrimitive.Description>}
      {t.action&&<ToastPrimitive.Action altText={t.action.label} asChild><button type="button" className="btn" data-variant="secondary" onClick={t.action.onClick}>{t.action.label}</button></ToastPrimitive.Action>}</div>
     <ToastPrimitive.Close className="toast-close" aria-label="Cerrar aviso"><X aria-hidden="true"/></ToastPrimitive.Close>
    </ToastPrimitive.Root>;})}
   <ToastPrimitive.Viewport className="toast-viewport"/>
  </ToastPrimitive.Provider>
 </ToastContext.Provider>;
}
export const useToast=()=>React.useContext(ToastContext);
