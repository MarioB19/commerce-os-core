import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {X} from 'lucide-react';
import {cn} from '../../lib/utils';
/** Radix Dialog: focus is trapped inside and returned to the trigger on
 * close (`onCloseAutoFocus` default). Escape and the overlay close it. */
export const Dialog=DialogPrimitive.Root;
export const DialogTrigger=DialogPrimitive.Trigger;
export const DialogClose=DialogPrimitive.Close;
export function DialogContent({className,title,description,children,wide,hideClose,...props}:React.ComponentProps<typeof DialogPrimitive.Content>&{title:React.ReactNode;description?:React.ReactNode;wide?:boolean;hideClose?:boolean}){
 return <DialogPrimitive.Portal>
  <DialogPrimitive.Overlay className="dialog-overlay"/>
  <DialogPrimitive.Content className={cn('dialog',wide&&'wide',className)} {...props}>
   <DialogPrimitive.Title asChild><h2>{title}</h2></DialogPrimitive.Title>
   {description?<DialogPrimitive.Description className="dialog-description">{description}</DialogPrimitive.Description>:<DialogPrimitive.Description className="sr-only">{typeof title==='string'?title:'Diálogo'}</DialogPrimitive.Description>}
   {children}
   {!hideClose&&<DialogPrimitive.Close className="icon-button dialog-close" aria-label="Cerrar"><X aria-hidden="true"/></DialogPrimitive.Close>}
  </DialogPrimitive.Content>
 </DialogPrimitive.Portal>;
}
export function DialogActions({children}:{children:React.ReactNode}){return <div className="dialog-actions">{children}</div>;}
