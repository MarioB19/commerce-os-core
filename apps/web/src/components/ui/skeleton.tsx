import {cn} from '../../lib/utils';
/** Placeholder with the final shape; announced once as «Consultando…». */
export function Skeleton({lines=3,block,label='Consultando…',className}:{lines?:number;block?:boolean;label?:string;className?:string}){
 return <div className={cn(block?'':'skeleton-lines',className)} aria-busy="true">
  <span className="sr-only">{label}</span>
  {block?<span className="skeleton block" aria-hidden="true"/>:Array.from({length:lines},(_,i)=><span key={i} className="skeleton" aria-hidden="true" style={{width:`${[92,76,60,84,48][i%5]}%`}}/>)}
 </div>;
}
