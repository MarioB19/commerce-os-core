import * as React from 'react';
import {CircleAlert,Inbox} from 'lucide-react';
import {Button} from './button';
import {cn} from '../../lib/utils';
/** Empty with one useful action (never a zero in place of «sin dato»). */
export function EmptyState({title,description,action,icon,inline,className,level=2}:{title:React.ReactNode;description?:React.ReactNode;action?:React.ReactNode;icon?:React.ReactNode;inline?:boolean;className?:string;level?:2|3}){
 const H=level===2?'h2':'h3';
 return <div className={cn('empty-state',inline&&'inline',className)}>{icon??<Inbox aria-hidden="true"/>}<H>{title}</H>{description&&<p>{description}</p>}{action}</div>;
}
/** Error with the cause and a retry (RF-17: never a silent failure). */
export function ErrorState({message,onRetry,retryLabel='Reintentar',title='No se pudo consultar'}:{message:string;onRetry?:()=>void;retryLabel?:string;title?:string}){
 return <div className="error-state" role="alert"><div><CircleAlert aria-hidden="true"/><div><strong>{title}</strong>{message}</div></div>{onRetry&&<Button variant="secondary" onClick={onRetry}>{retryLabel}</Button>}</div>;
}
