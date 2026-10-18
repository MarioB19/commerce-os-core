import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import {cn} from '../../lib/utils';
/** Radix Tabs (1.2.1) for in-page panels. Route-level sections stay links. */
export const Tabs=TabsPrimitive.Root;
export function TabsList({className,...props}:React.ComponentProps<typeof TabsPrimitive.List>){return <TabsPrimitive.List className={cn('tabs-list',className)} {...props}/>;}
export function TabsTrigger({className,...props}:React.ComponentProps<typeof TabsPrimitive.Trigger>){return <TabsPrimitive.Trigger className={cn(className)} {...props}/>;}
export function TabsContent({className,...props}:React.ComponentProps<typeof TabsPrimitive.Content>){return <TabsPrimitive.Content className={cn('tabs-content',className)} {...props}/>;}
/** Link tabs: the same look for sub-navigation made of real routes. */
export function LinkTabs({items,current,label,className}:{items:{href:string;label:React.ReactNode;key?:string}[];current:string;label:string;className?:string}){
 return <nav aria-label={label} className={cn('tabs-list',className)}>{items.map(i=><a key={i.key??i.href} href={i.href} aria-current={(i.key??i.href)===current?'page':undefined}>{i.label}</a>)}</nav>;
}
