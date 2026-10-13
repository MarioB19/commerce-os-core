import {useEffect,useState} from 'react';
import {z} from 'zod';
import {profileRequest,type ProfileFence} from '../lib/profile-request.js';

/** RF-04.a: Inicio separates connection, aptitude to attend and sales done,
 * with operator-language causes and one next step. */
const homeSchema=z.object({timezone:z.string(),
 numbers:z.object({registered:z.number(),connected:z.number(),attending:z.number(),causes:z.object({DISCONNECTED:z.number(),PAUSED:z.number(),NOT_AUTHORIZED:z.number()})}),
 today:z.object({conversations:z.number(),orders:z.number(),approvedReceipts:z.number()}),
 pending:z.object({receiptsToReview:z.number(),alerts:z.number(),criticalAlerts:z.number()}),
 onboarding:z.object({complete:z.boolean(),dismissed:z.boolean(),next:z.string().nullable()}).nullable(),
 next:z.object({kind:z.string(),step:z.string().nullable().optional(),count:z.number().optional()}).nullable()});
type Home=z.infer<typeof homeSchema>;
const nextAction:Record<string,{text:(h:Home)=>string;href:string}>={
 REVIEW_RECEIPTS:{text:h=>`Revisar ${h.pending.receiptsToReview} comprobante${h.pending.receiptsToReview===1?'':'s'}`,href:'/sales/receipts'},
 RECONNECT_NUMBERS:{text:h=>`Reconectar ${h.numbers.causes.DISCONNECTED} número${h.numbers.causes.DISCONNECTED===1?'':'s'}`,href:'/numbers'},
 REVIEW_ALERTS:{text:h=>`Revisar ${h.pending.alerts} aviso${h.pending.alerts===1?'':'s'}`,href:'/numbers'},
};
export function ProfileHome({selection}:{selection:ProfileFence}){
 const [home,setHome]=useState<Home>(),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();setHome(undefined);setError('');
  profileRequest(selection,'GET','/v2/home',undefined,controller.signal).then(v=>setHome(homeSchema.parse(v))).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'No se pudo consultar el resumen.');});
  return()=>controller.abort();},[selection.workspaceId,selection.version]);
 if(error)return <p role="alert">{error}</p>;
 if(!home)return <p role="status">Consultando el resumen…</p>;
 const causes=[home.numbers.causes.DISCONNECTED&&`${home.numbers.causes.DISCONNECTED} desconectado${home.numbers.causes.DISCONNECTED===1?'':'s'}`,home.numbers.causes.PAUSED&&`${home.numbers.causes.PAUSED} en pausa`,home.numbers.causes.NOT_AUTHORIZED&&`${home.numbers.causes.NOT_AUTHORIZED} sin autorización para vender`].filter(Boolean);
 const action=home.next&&home.next.kind!=='ONBOARDING'?nextAction[home.next.kind]:undefined;
 return <div className="profile-home">
  {action&&<a className="button-primary" href={action.href}>{action.text(home)}</a>}
  {/* RF-04.b/RF-17.g: pending receipts stay one click away even while the setup guide leads. */}
  {home.pending.receiptsToReview>0&&action!==nextAction.REVIEW_RECEIPTS&&<p className="profile-home-pending"><a href="/sales/receipts">{nextAction.REVIEW_RECEIPTS!.text(home)}</a></p>}
  <dl className="profile-home-stats">
   <div><dt>Números conectados</dt><dd>{home.numbers.connected} de {home.numbers.registered}</dd></div>
   <div><dt>Atendiendo</dt><dd>{home.numbers.attending}</dd>{causes.length>0&&<dd className="cause">{causes.join(' · ')}</dd>}</div>
   <div><dt>Conversaciones hoy</dt><dd>{home.today.conversations}</dd></div>
   <div><dt>Pedidos hoy</dt><dd>{home.today.orders}</dd></div>
   <div><dt>Pagos aprobados hoy</dt><dd>{home.today.approvedReceipts}</dd></div>
   <div><dt>Comprobantes por revisar</dt><dd>{home.pending.receiptsToReview>0?<a href="/sales/receipts">{home.pending.receiptsToReview}</a>:0}</dd></div>
  </dl>
  {home.pending.criticalAlerts>0&&<p role="status">Hay {home.pending.criticalAlerts} aviso{home.pending.criticalAlerts===1?'':'s'} importante{home.pending.criticalAlerts===1?'':'s'} sobre tus números.</p>}
 </div>;
}
