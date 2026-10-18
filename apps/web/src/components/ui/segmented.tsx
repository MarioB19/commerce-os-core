import * as React from 'react';
import {cn} from '../../lib/utils';
export interface SegmentedOption<T extends string> {value:T;label:React.ReactNode;count?:number}
/** Exclusive filter group with `aria-pressed` (the E2E and screen readers read it). */
export function Segmented<T extends string>({value,onChange,options,label,className}:{value:T;onChange:(v:T)=>void;options:SegmentedOption<T>[];label:string;className?:string}){
 return <div className={cn('segmented',className)} role="group" aria-label={label}>
  {options.map(o=><button key={o.value} type="button" aria-pressed={value===o.value} onClick={()=>onChange(o.value)}>{o.label}{o.count!==undefined&&<span className="count">{o.count}</span>}</button>)}
 </div>;
}
