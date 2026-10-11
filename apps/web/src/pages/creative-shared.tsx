import {useId,type ReactNode} from 'react';
import {Link} from '@tanstack/react-router';
import {Badge,ErrorState} from '../components/shared';
import {Button} from '../components/ui/button';
import {object,str} from '../lib/api';
import './creative.css';
export type CreativeObject=Record<string,any>;
export function Experimental({studio=false}:{studio?:boolean}){return <div className="creative-experimental"><Badge tone="warning">Experimental</Badge><p>{studio?'La producción requiere un equipo compatible conectado. Los archivos compartidos permanecen disponibles en tu biblioteca.':'Las señales de anuncios no demuestran ventas.'}</p><Link to="/settings/integrations">Integraciones y presupuesto</Link></div>;}
export function CreativeField({label,children,hint}:{label:string;children:ReactNode;hint?:string}){const id=useId();return <div className="creative-field"><label id={id}>{label}</label><div aria-labelledby={id}>{children}</div>{hint&&<small>{hint}</small>}</div>;}
export function JsonEditor({label,value,onChange,rows=10}:{label:string;value:string;onChange:(s:string)=>void;rows?:number}){return <label className="creative-field">{label}<textarea className="creative-code" aria-label={label} value={value} onChange={e=>onChange(e.target.value)} rows={rows} spellCheck={false}/></label>;}
export function CreativeError({error}:{error:unknown}){if(!error)return null;return <ErrorState error={error instanceof Error?error:new Error(str(object(error).message,'No se pudo completar la operación.'))}/>;}
export function CreativeEmpty({children}:{children:ReactNode}){return <div className="creative-empty">{children}</div>;}
export function CreativeTabs({values,value,onChange}:{values:readonly string[];value:string;onChange:(v:string)=>void}){return <nav className="creative-tabs" aria-label="Secciones">{values.map(tab=><Button key={tab} variant={value===tab?'default':'secondary'} aria-pressed={value===tab} onClick={()=>onChange(tab)}>{tab}</Button>)}</nav>;}
export function friendlyState(value:unknown){const labels:Record<string,string>={QUEUED:'En cola',REVIEW:'Revisión pendiente',RETRY:'Esperando reintento',CONNECTED:'Conectado',OFFLINE:'Sin conexión',STAGING:'Subida pendiente',UPLOADING:'Subiendo',VERIFYING:'Verificando',CLOSING:'Finalizando subida',ABORTING:'Cancelando subida',ABORTED:'Subida cancelada',WAITING:'Esperando equipo',RUNNING:'En proceso',COMPLETED:'Completado',SUCCEEDED:'Completado',UNKNOWN:'Resultado incierto · conserva reserva',FAILED:'Falló',PARTIAL:'Cobertura parcial',STALE:'Cache caducado',UNAVAILABLE:'No disponible',READY:'Listo',DRAFT:'Borrador',PENDING:'Pendiente',APPROVED:'Aprobado',REVOKED:'Revocado',CHANGES_REQUESTED:'Requiere cambios'};return labels[String(value)]??str(value);}
export function timestamp(value:unknown){if(!value)return 'Sin observación';const date=new Date(String(value));return Number.isNaN(date.getTime())?'Fecha desconocida':date.toLocaleString('es-MX');}
