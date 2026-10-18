import * as React from 'react';
import {CircleAlert} from 'lucide-react';
import {cn} from '../../lib/utils';

export interface FieldProps {
 label:React.ReactNode;
 /** Shown after the label in a lighter weight, e.g. «(opcional)». */
 optional?:boolean;
 help?:React.ReactNode;
 error?:React.ReactNode;
 id?:string;
 className?:string;
 /** When the control is nested (e.g. inside a row), the id of the control the label points to; the child is rendered as is. */
 htmlFor?:string;
 /** The control. It receives `id`, `aria-describedby` and `aria-invalid`. */
 children:React.ReactElement<{id?:string;'aria-describedby'?:string;'aria-invalid'?:React.AriaAttributes['aria-invalid']}>;
}
/** Label + help + error next to the control (RF-17: validation beside the
 * field, label always visible, never a placeholder as the only label). */
export function Field({label,optional,help,error,id,className,htmlFor,children}:FieldProps){
 const generated=React.useId(),controlId=htmlFor??id??children.props.id??generated,helpId=controlId+'-help',errorId=controlId+'-error';
 const described=[children.props['aria-describedby'],help?helpId:null,error?errorId:null].filter(Boolean).join(' ')||undefined;
 return <div className={cn('field',className)}>
  <label className="field-label" htmlFor={controlId}>{label}{optional&&<span className="optional"> (opcional)</span>}</label>
  {htmlFor?children:React.cloneElement(children,{id:controlId,'aria-describedby':described,'aria-invalid':error?true:children.props['aria-invalid']})}
  {help&&<span className="field-help" id={helpId}>{help}</span>}
  {error&&<span className="field-error" id={errorId} role="alert"><CircleAlert aria-hidden="true"/>{error}</span>}
 </div>;
}
/** Errors of a whole form, navigable (RF-17): one link per field. */
export function ErrorSummary({errors,title='Revisa estos campos:'}:{errors:{id:string;message:string}[];title?:string}){
 if(!errors.length)return null;
 return <div className="alert" data-tone="error" role="alert" tabIndex={-1}>
  <CircleAlert aria-hidden="true"/>
  <div className="alert-body"><strong>{title}</strong><ul>{errors.map(e=><li key={e.id}><a href={'#'+e.id} onClick={ev=>{ev.preventDefault();document.getElementById(e.id)?.focus();}}>{e.message}</a></li>)}</ul></div>
 </div>;
}
