import * as React from 'react';
import {TrendingDown,TrendingUp,Minus} from 'lucide-react';
export interface Delta {text:string;tone:'good'|'bad'|'flat'}
/** One figure with its label, an optional comparison and a reason when the
 * figure is missing (never a zero in place of «sin dato»). */
export function Kpi({label,value,hint,delta,before,missing,icon}:{label:React.ReactNode;value:React.ReactNode;hint?:React.ReactNode;delta?:Delta|null;before?:string|null;missing?:boolean;icon?:React.ReactNode}){
 const Icon=delta?.tone==='good'?TrendingUp:delta?.tone==='bad'?TrendingDown:Minus;
 return <div className="kpi">
  <span className="kpi-label">{icon}{label}</span>
  <strong className={missing?'kpi-value missing':'kpi-value'}>{value}</strong>
  {(delta||before)&&<span className="kpi-hint">{delta&&<span className="kpi-delta" data-tone={delta.tone}><Icon aria-hidden="true"/>{delta.text}</span>}{before?` · antes ${before}`:''}</span>}
  {hint&&<span className="kpi-hint">{hint}</span>}
 </div>;
}
