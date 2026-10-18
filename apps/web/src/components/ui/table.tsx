import * as React from 'react';
import {ArrowDown,ArrowUp,ArrowUpDown} from 'lucide-react';
import {cn} from '../../lib/utils';

/** Scroll region with the table inside; the box scrolls, never the page. */
export function TableWrap({className,children,label}:{className?:string;children:React.ReactNode;label?:string}){
 return <div className={cn('table-wrap',className)} role={label?'region':undefined} aria-label={label} tabIndex={label?0:undefined}>{children}</div>;
}
export function Table({className,stackMobile=true,...props}:React.ComponentProps<'table'>&{stackMobile?:boolean}){
 return <table className={cn('table',stackMobile&&'stack-mobile',className)} {...props}/>;
}
export type SortDirection='asc'|'desc';
/** Sortable header cell: `aria-sort` on the th, a button inside. */
export function SortableTh({children,active,direction,onSort,className,...props}:React.ComponentProps<'th'>&{active:boolean;direction:SortDirection;onSort:()=>void}){
 const Icon=!active?ArrowUpDown:direction==='asc'?ArrowUp:ArrowDown;
 return <th scope="col" aria-sort={active?(direction==='asc'?'ascending':'descending'):'none'} className={className} {...props}>
  <button type="button" className="sort-button" onClick={onSort}>{children}<Icon aria-hidden="true"/><span className="sr-only">{active?(direction==='asc'?', orden ascendente':', orden descendente'):', ordenar'}</span></button>
 </th>;
}
export function useSort<T>(rows:T[],initial:{key:keyof T;direction:SortDirection}){
 const [sort,setSort]=React.useState(initial);
 const sorted=React.useMemo(()=>{const copy=[...rows];const dir=sort.direction==='asc'?1:-1;copy.sort((a,b)=>{const x=a[sort.key],y=b[sort.key];if(x===y)return 0;if(x===null||x===undefined)return 1;if(y===null||y===undefined)return -1;return (x<y?-1:1)*dir;});return copy;},[rows,sort]);
 const toggle=(key:keyof T)=>setSort(s=>s.key===key?{key,direction:s.direction==='asc'?'desc':'asc'}:{key,direction:'asc'});
 return {sorted,sort,toggle};
}
