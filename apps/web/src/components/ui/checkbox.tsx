import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import {Check} from 'lucide-react';
import {cn} from '../../lib/utils';

export interface CheckboxProps {
 checked:boolean;
 onCheckedChange:(checked:boolean)=>void;
 label:React.ReactNode;
 description?:React.ReactNode;
 disabled?:boolean;
 id?:string;
 className?:string;
 name?:string;
 required?:boolean;
}
/** Radix Checkbox (1.4.1) with a permanent, clickable label (target ≥ 44 px). */
export function Checkbox({checked,onCheckedChange,label,description,disabled,id,className,name,required}:CheckboxProps){
 const generated=React.useId(),controlId=id??generated;
 return <label className={cn('checkbox',className)} htmlFor={controlId}>
  <CheckboxPrimitive.Root id={controlId} className="checkbox-box" checked={checked} onCheckedChange={v=>onCheckedChange(v===true)} disabled={disabled} name={name} required={required}>
   <CheckboxPrimitive.Indicator><Check aria-hidden="true"/></CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
  <span className="checkbox-text"><span>{label}</span>{description&&<small>{description}</small>}</span>
 </label>;
}
/** Native checkbox/radio inside a label, for forms the E2E drives with `check()`. */
export function NativeCheck({label,className,type='checkbox',...props}:React.ComponentProps<'input'>&{label:React.ReactNode}){
 return <label className={cn(type==='radio'?'radio':'checkbox',className)}><input type={type} className="native" {...props}/><span className="checkbox-text"><span>{label}</span></span></label>;
}
