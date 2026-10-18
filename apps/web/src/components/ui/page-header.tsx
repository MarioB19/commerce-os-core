import * as React from 'react';
import {ArrowLeft} from 'lucide-react';
/** Title, one line, one primary action (RF-17.b). The `h1` id is the page's
 * accessible name for `aria-labelledby`. */
export function PageHeader({title,description,actions,badge,back,id='page-title'}:{title:React.ReactNode;description?:React.ReactNode;actions?:React.ReactNode;badge?:React.ReactNode;back?:{href:string;label:string};id?:string}){
 return <header className="page-header">
  <div>
   {back&&<a className="back-link" href={back.href}><ArrowLeft aria-hidden="true"/>{back.label}</a>}
   <h1 id={id}>{title}{badge}</h1>
   {description&&<p>{description}</p>}
  </div>
  {actions&&<div className="page-header-actions">{actions}</div>}
 </header>;
}
