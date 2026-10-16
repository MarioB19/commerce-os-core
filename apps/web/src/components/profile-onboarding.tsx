import {useEffect,useId,useState} from 'react';
import type {ProfileRole,ProfileState} from '../../../../packages/contracts/src/profiles.js';
import {loadOnboarding,updateOnboarding,type Onboarding} from '../lib/profile-integrations.js';
import type {ProfileFence} from '../lib/profile-request.js';
import {Button} from './ui/button';

/** RF-13.c / RF-04.d: four steps derived from saved facts, so the guide resumes
 * after logout or restart without asking for anything twice. */
const steps=[
 {key:'ai',title:'Conecta tu inteligencia artificial',text:'Guarda la clave de tu proveedor; la verificamos con una consulta mínima.',href:'/account/integrations',cta:'Configurar IA'},
 {key:'meta',title:'Conecta Meta (opcional)',text:'Para consultar tus campañas y resultados. Puedes omitirlo.',href:'/account/integrations#meta',cta:'Conectar Meta'},
 {key:'product',title:'Crea tu primer producto',text:'Un producto con su primera variante de mercado.',href:'/products',cta:'Crear producto'},
 {key:'number',title:'Agrega tu primer número',text:'Vincula un número de WhatsApp escaneando su código QR.',href:'/numbers',cta:'Agregar número'},
] as const;
const stateText={DONE:'Listo',SKIPPED:'Omitido',PENDING:'Pendiente'} as const;
export function ProfileOnboarding({selection,role,state}:{selection:ProfileFence;role:ProfileRole;state:ProfileState}){
 const id=useId(),[data,setData]=useState<Onboarding>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{const controller=new AbortController();setData(undefined);loadOnboarding(selection,controller.signal).then(setData).catch(failure=>{if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'No se pudo consultar la configuración inicial.');});return()=>controller.abort();},[selection.workspaceId,selection.version]);
 if(error)return <p role="alert">{error}</p>;
 if(!data||data.complete||data.dismissed)return null;
 const owner=role==='owner'&&state==='ACTIVE';
 async function change(input:{metaSkipped?:boolean;dismissed?:boolean}){if(!data||busy)return;setBusy(true);setError('');try{setData(await updateOnboarding(selection,{expectedVersion:data.version,...input}));}catch(failure){setError(failure instanceof Error?failure.message:'No se pudo guardar.');}finally{setBusy(false);}}
 const next=steps.find(step=>step.key===data.next);
 return <section className="card onboarding" aria-labelledby={id}>
  <h2 id={id}>Configura tu negocio</h2>
  <ol className="onboarding-steps">{steps.map(step=>{const value=data.steps[step.key];return <li key={step.key} aria-current={step.key===data.next?'step':undefined} className={'onboarding-step onboarding-'+value.toLowerCase()}>
   <strong>{step.title}</strong> <span className="status">{stateText[value]}</span><p>{step.text}</p>
  </li>;})}</ol>
  {next&&<div className="onboarding-actions"><a className="button-primary" href={next.href}>{next.cta}</a>
   {next.key==='meta'&&owner&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{void change({metaSkipped:true});}}>Omitir Meta por ahora</Button>}</div>}
  {owner&&<Button type="button" variant="ghost" disabled={busy} onClick={()=>{void change({dismissed:true});}}>Ocultar esta guía</Button>}
 </section>;
}
