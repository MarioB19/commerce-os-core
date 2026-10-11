import {useState} from 'react';
import {standardStages} from '../../../../packages/domain/src/warmup/policy.js';
import {Feedback,QueryState,useWorkspace} from './shared';
import {Button} from './ui/button';
import {Modal} from './ui/dialog';
import {params,useAction,useData,type Row} from '../lib/api';
import './warmup.css';

type Turn={kind:'text'|'image'|'audio'|'document';text:string;asset_id:string};
const emptyTurn=():Turn=>({kind:'text',text:'',asset_id:''});
const kindLabels={text:'Texto',image:'Imagen',audio:'Audio',document:'Documento'};
const phaseLabels=['Inicio','Reciprocidad','Volumen medio','Volumen alto','Evaluación'];

function compatibleAsset(asset:Row,kind:Turn['kind']){
 if(asset.kind!=='file'||asset.status!=='READY')return false;
 const mime=String(asset.mime_type??'');
 return kind==='image'?mime.startsWith('image/'):kind==='audio'?mime.startsWith('audio/'):kind==='document'?['application/pdf','application/octet-stream'].includes(mime):false;
}

export function WarmupContentEditor(){
 const {environment}=useWorkspace(),action=useAction();
 const [open,setOpen]=useState(false),[label,setLabel]=useState(''),[turns,setTurns]=useState<Turn[]>([emptyTurn(),emptyTurn()]),[confirmed,setConfirmed]=useState(false);
 const assets=useData(`/assets${params(environment,{limit:'200'})}`,open);
 const update=(index:number,patch:Partial<Turn>)=>{setTurns(current=>current.map((turn,i)=>i===index?{...turn,...patch}:turn));setConfirmed(false);};
 const valid=label.trim().length>=3&&label.length<=100&&turns.length>=2&&turns.length<=20&&turns.every(turn=>turn.kind==='text'?turn.text.trim().length>0:assets.data?.some(asset=>asset.id===turn.asset_id&&compatibleAsset(asset,turn.kind)));
 return <><Button variant="secondary" onClick={()=>setOpen(true)}>Agregar contenido aprobado</Button>
  <Modal title="Aprobar conversación del pool propio" description="Escribe de 2 a 20 turnos alternados entre dos números propios. Guardar el contenido conserva pendiente la autorización de envío." open={open} onOpenChange={setOpen}>
   <form className="warmup-content-editor" onSubmit={event=>{event.preventDefault();if(!valid||!confirmed)return;void action.mutateAsync({path:'/warmup/content',body:{label:label.trim(),turns:turns.map(turn=>({kind:turn.kind,...(turn.text.trim()?{text:turn.text}:{}),...(turn.kind!=='text'?{asset_id:turn.asset_id}:{})})),ownership_confirmed:confirmed}}).then(()=>{setOpen(false);setLabel('');setTurns([emptyTurn(),emptyTurn()]);setConfirmed(false);}).catch(()=>{});}}>
    <label className="field"><span>Nombre de la conversación</span><input required minLength={3} maxLength={100} value={label} onChange={event=>{setLabel(event.target.value);setConfirmed(false);}}/></label>
    <details className="warmup-budget-guide" open>
     <summary>Compatibilidad con la curva estándar · {turns.length} turnos</summary>
     <p>Cada turno consume un mensaje de ambos participantes. La tabla indica cuántas conversaciones distintas de esta longitud caben en un día sin reducción de fin de semana. El planificador valida también horarios, peers, límites y contenido disponible.</p>
     <div className="table-scroll" tabIndex={0} role="region" aria-label="Límites y compatibilidad por fase"><table><thead><tr><th>Fase y días</th><th>Mensajes / conversaciones</th><th>Con esta longitud</th></tr></thead><tbody>{standardStages.map((stage,index)=>{
      const minimum=Math.max(stage.conversations[0],Math.ceil(stage.messages[0]/turns.length)),maximum=Math.min(stage.conversations[1],Math.floor(stage.messages[1]/turns.length));
      return <tr key={stage.first}><th scope="row">Fase {index+1} · {phaseLabels[index]}<small>Días {stage.first}–{stage.last}</small></th><td>{stage.messages[0]}–{stage.messages[1]} mensajes<br/>{stage.conversations[0]}–{stage.conversations[1]} conversaciones</td><td>{minimum<=maximum?`${minimum===maximum?minimum:minimum+'–'+maximum} conversaciones distintas`:'Esta longitud sola no cubre la fase'}</td></tr>;
     })}</tbody></table></div>
     <p>En recepción ligera se aplica la primera fila. No se reutiliza una conversación aprobada para el mismo número; prepara contenido propio suficiente para los días previstos.</p>
    </details>
    <div className="warmup-turn-list">{turns.map((turn,index)=><fieldset key={index} className="warmup-turn"><legend>Turno {index+1} · Número {index%2===0?'A':'B'}</legend>
     <div className="warmup-turn-heading"><label className="field"><span>Tipo del turno {index+1}</span><select value={turn.kind} onChange={event=>update(index,{kind:event.target.value as Turn['kind'],asset_id:''})}>{Object.entries(kindLabels).map(([kind,name])=><option key={kind} value={kind}>{name}</option>)}</select></label><Button type="button" variant="ghost" disabled={turns.length<=2} aria-label={`Quitar turno ${index+1}`} onClick={()=>{setTurns(current=>current.filter((_,i)=>i!==index));setConfirmed(false);}}>Quitar</Button></div>
     <label className="field"><span>{turn.kind==='text'?'Mensaje':'Texto opcional'} del turno {index+1}</span><textarea rows={3} required={turn.kind==='text'} maxLength={2000} value={turn.text} onChange={event=>update(index,{text:event.target.value})}/></label>
     {turn.kind!=='text'&&<QueryState query={assets}><label className="field"><span>Archivo aprobado del turno {index+1}</span><select aria-label={`Archivo aprobado del turno ${index+1}`} required value={turn.asset_id} onChange={event=>update(index,{asset_id:event.target.value})}><option value="">Selecciona un archivo listo…</option>{assets.data?.filter(asset=>compatibleAsset(asset,turn.kind)).map(asset=><option key={asset.id} value={asset.id}>{String(asset.name??'Archivo propio')} · {String(asset.mime_type)}</option>)}</select><small>Usa archivos propios preparados en Catálogo. La autorización del pool comprobará la capacidad del proveedor para este tipo de contenido.</small></label></QueryState>}
    </fieldset>)}</div>
    <div className="button-group"><Button type="button" variant="secondary" disabled={turns.length>=20} onClick={()=>{setTurns(current=>[...current,emptyTurn()]);setConfirmed(false);}}>Añadir turno</Button><span>{turns.length} de 20 turnos</span></div>
    <label className="checkbox-row"><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>Confirmo que todos los turnos y archivos son propios, pertinentes al negocio y aprobados, y que ambos números han consentido esta conversación.</label>
    <Feedback error={action.error}/><Button disabled={!valid||!confirmed||action.isPending}>Guardar contenido aprobado</Button>
   </form>
  </Modal>
 </>;
}
