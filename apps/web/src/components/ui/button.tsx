import * as React from 'react';
import {Slot} from '@radix-ui/react-slot';
import {cn} from '../../lib/utils';

export type ButtonVariant='default'|'secondary'|'ghost'|'destructive';
export type ButtonSize='default'|'sm'|'icon';
export interface ButtonProps extends React.ComponentProps<'button'> {
 variant?:ButtonVariant;
 size?:ButtonSize;
 asChild?:boolean;
 /** Shows a spinner, keeps the width and disables the control. */
 loading?:boolean;
}
/** V7 button. `data-variant="default"` is the single primary action of a page
 * (RF-17.b); the E2E suite counts it, so the attribute is part of the contract. */
export function Button({className,variant='default',size='default',asChild=false,loading=false,disabled,children,...props}:ButtonProps){
 const Comp=asChild?Slot:'button';
 return <Comp data-variant={variant} data-size={size} data-loading={loading?'true':undefined} className={cn('btn',className)} disabled={disabled||loading} aria-busy={loading||undefined} {...props}>
  {loading&&<span className="spinner" aria-hidden="true"/>}
  {children}
 </Comp>;
}
/** A link that looks like a button (keeps `data-variant` for the primary rule). */
export function ButtonLink({className,variant='default',size='default',...props}:React.ComponentProps<'a'>&{variant?:ButtonVariant;size?:ButtonSize}){
 return <a data-variant={variant} data-size={size} className={cn('btn',className)} {...props}/>;
}
