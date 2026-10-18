import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import {Check,ChevronDown,ChevronUp} from 'lucide-react';
import {cn} from '../../lib/utils';

/** Native select: forms, long lists and everything the E2E drives with
 * `selectOption`. Styled with the same tokens as the Radix one. */
export function NativeSelect({className,...props}:React.ComponentProps<'select'>){
 return <select className={cn('select-native',className)} {...props}/>;
}

export interface SelectOption {value:string;label:string;disabled?:boolean}
export interface SelectProps {
 value:string;
 onValueChange:(value:string)=>void;
 options:SelectOption[];
 placeholder?:string;
 id?:string;
 'aria-label'?:string;
 'aria-labelledby'?:string;
 disabled?:boolean;
 className?:string;
 name?:string;
}
/** Radix Select (2.4.1): compact pickers in headers and toolbars. */
export function Select({value,onValueChange,options,placeholder,id,disabled,className,name,...aria}:SelectProps){
 return <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled} name={name}>
  <SelectPrimitive.Trigger id={id} className={cn('select-trigger',className)} aria-label={aria['aria-label']} aria-labelledby={aria['aria-labelledby']}>
   <SelectPrimitive.Value placeholder={placeholder}/>
   <SelectPrimitive.Icon asChild><ChevronDown aria-hidden="true"/></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
  <SelectPrimitive.Portal>
   <SelectPrimitive.Content className="select-content" position="popper" sideOffset={4}>
    <SelectPrimitive.ScrollUpButton className="select-scroll"><ChevronUp aria-hidden="true"/></SelectPrimitive.ScrollUpButton>
    <SelectPrimitive.Viewport className="select-viewport">
     {options.map(o=><SelectPrimitive.Item key={o.value} value={o.value} disabled={o.disabled} className="select-item">
      <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="select-item-indicator"><Check aria-hidden="true"/></SelectPrimitive.ItemIndicator>
     </SelectPrimitive.Item>)}
    </SelectPrimitive.Viewport>
    <SelectPrimitive.ScrollDownButton className="select-scroll"><ChevronDown aria-hidden="true"/></SelectPrimitive.ScrollDownButton>
   </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
 </SelectPrimitive.Root>;
}
