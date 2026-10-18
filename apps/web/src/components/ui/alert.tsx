import * as React from 'react';
import {CircleAlert,CircleCheck,CircleX,Info} from 'lucide-react';
import {cn} from '../../lib/utils';
const icons={success:CircleCheck,warn:CircleAlert,error:CircleX,info:Info,neutral:Info};
/** Inline message with icon + text + colour. `role` follows the tone
 * (`alert` for errors, `status` otherwise) unless overridden. */
export function Alert({tone='info',title,children,actions,role,className,id,tabIndex}:{tone?:'success'|'warn'|'error'|'info'|'neutral';title?:React.ReactNode;children?:React.ReactNode;actions?:React.ReactNode;role?:'alert'|'status'|'note'|'region'|'none';className?:string;id?:string;tabIndex?:number}){
 const Icon=icons[tone];
 return <div className={cn('alert',className)} data-tone={tone} role={role??(tone==='error'?'alert':'status')} id={id} tabIndex={tabIndex}>
  <Icon aria-hidden="true"/>
  <div className="alert-body">{title&&<strong>{title}</strong>}{children}{actions&&<div className="alert-actions">{actions}</div>}</div>
 </div>;
}
