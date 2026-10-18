import * as React from 'react';
import {cn} from '../../lib/utils';
export function Card({className,compact,flat,as:Tag='section',...props}:React.ComponentProps<'section'>&{compact?:boolean;flat?:boolean;as?:'section'|'div'|'article'|'form'}){
 const Comp=Tag as React.ElementType;
 return <Comp className={cn('card',compact&&'compact',flat&&'flat',className)} {...props}/>;
}
export function CardHead({title,description,actions,level=2,id}:{title:React.ReactNode;description?:React.ReactNode;actions?:React.ReactNode;level?:2|3;id?:string}){
 const H=level===2?'h2':'h3';
 return <div className="card-head"><div><H id={id}>{title}</H>{description&&<p>{description}</p>}</div>{actions&&<div className="cluster">{actions}</div>}</div>;
}
