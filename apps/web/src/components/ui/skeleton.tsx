import {cn} from '../../lib/utils';
/** Placeholder with the final shape; announced once as «Consultando…». */
export function Skeleton({lines=3,block,label='Consultando…',className}:{lines?:number;block?:boolean;label?:string;className?:string}){
 return <div role="status" aria-label={label} className={cn(block?'':'skeleton-lines',className)} aria-busy="true">
  {block?<span className="skeleton block"/>:Array.from({length:lines},(_,i)=><span key={i} className="skeleton" style={{width:`${[92,76,60,84,48][i%5]}%`}}/>)}
 </div>;
}
