import {Badge,DataTable,Notice,Panel,QueryState,ResourceForm,useWorkspace,type Field} from './shared';
import {useData,object,str,type Row} from '../lib/api';
import {date} from '../lib/utils';
const labels:Record<string,string>={CONNECTED:'Conectada',STOPPED:'Detenida',STARTING:'Conectando',RECONNECTING:'Reconectando',QR_REQUIRED:'Necesita QR',UNKNOWN:'Sin confirmar',AUTH_FAILURE:'Autenticación revocada',CURRENT:'Al día',OVERDUE:'Mantenimiento vencido',DUE_10:'Revisar principal · día 10',DUE_12:'Revisar principal · día 12',DUE_13:'Revisar principal · día 13',NONE:'Sin recuperación solicitada',PREVIOUS_GENERATION_ONLY:'Respaldo de credenciales anteriores',QUARANTINE_VERIFIED:'Volumen anterior en cuarentena',VERIFIED_COLD_BACKUP:'Copia fría verificada',IDENTITY_VERIFIED_REVIEW_REQUIRED:'Identidad verificada · revisar reanudación',AWAITING_NEW_QR:'Pendiente de un nuevo QR',AWAITING_ISOLATION:'Pendiente de aislar la sesión anterior',STORAGE_REPLACEMENT_REQUESTED:'Reemplazo de almacenamiento solicitado'};
const reason:Field={name:'reason',label:'Motivo o evidencia',required:true,type:'textarea',advanced:false};
export function SessionContinuity({account,section}:{account:Row;section:'primary'|'recovery'|'connection'}){
 const {environment,session:actor}=useWorkspace();
 const query=useData<Row>(`/channel-accounts/${account.id}/session?environment=${environment}`,true,10000);
 const users=useData('/users',section==='primary'&&actor.role==='owner');
 const s=query.data,maintenance=object(s?.maintenance),inventory=object(s?.inventory);
 const path=`/channel-accounts/${account.id}`;
 const version=(body:Record<string,unknown>)=>({...body,expected_version:s?.revision});
 return <QueryState query={query}>{s&&<div className="session-continuity">
 {section==='connection'&&<div className="session-summary" aria-label="Estado de la sesión">
  <div><span>Conexión verificada</span><strong>{labels[str(s.observed_state)]??str(s.observed_state)}</strong><small>{s.health_fresh?'Señal vigente':'Señal vencida o desconocida'}</small></div>
  <div><span>Última conexión con identidad</span><strong>{s.last_connected_at?date(str(s.last_connected_at)):'Sin confirmar'}</strong><small>Estado del principal: {labels[str(maintenance.status)]??'Sin confirmar'}</small></div>
  <div><span>Envíos</span><strong>{s.sending_enabled?'Sujetos a controles vigentes':'Deshabilitados'}</strong><small>Conectar no habilita envíos.</small></div>
 </div>}
 {section==='primary'&&<>
  <Panel title="Teléfono principal" description="Abre WhatsApp en el principal cada semana y registra el uso real.">
   <Badge>{labels[str(maintenance.status)]??str(maintenance.status)}</Badge>
   <dl className="session-facts"><div><dt>Último uso declarado</dt><dd>{s.primary_last_used_at?date(str(s.primary_last_used_at)):'Desconocido'}</dd></div><div><dt>Fuente</dt><dd>{s.primary_usage_source?'Confirmación registrada por un operador':'Sin declaración'}</dd></div><div><dt>Responsable</dt><dd>{str(s.responsible_name,'Sin asignar')}</dd></div><div><dt>Principal</dt><dd>{str(s.primary_device_id,'Sin identificar')}</dd></div><div><dt>Próxima rutina semanal</dt><dd>{maintenance.next_due_at?date(str(maintenance.next_due_at)):'Registra el primer uso'}</dd></div></dl>
   <ResourceForm title="Registrar uso del principal" description="Confirma cuándo abriste WhatsApp en el teléfono principal. La actividad de WAHA no cuenta como uso del principal." trigger="Registrar uso del principal" path={`${path}/primary-usage`} fields={[{name:'used_at',label:'Fecha y hora del uso real',type:'datetime-local',required:true},reason]} transform={body=>({...version(body),source:'operator_confirmation'})}/>
  </Panel>
  <Panel title="Responsable y mantenimiento">
   <ResourceForm title="Editar mantenimiento del principal" trigger="Editar responsable y principal" method="PATCH" path={`${path}/session`} initial={{...s,version:s.revision,...inventory}} fields={[
    {name:'primary_device_id',label:'Identificador interno del teléfono',required:true,hint:'Usa un alias como Equipo-01. Evita números de teléfono.'},
    {name:'responsible_user_id',label:'Persona responsable',type:'select',required:true,options:(users.data??[{id:actor.user.id,name:actor.user.name}]).map(u=>({value:u.id,label:u.name??u.id}))},
    {name:'primary_availability',label:'Disponibilidad del principal',type:'select',required:true,options:[{value:'AVAILABLE',label:'Disponible'},{value:'UNAVAILABLE',label:'No disponible'},{value:'UNKNOWN',label:'Sin confirmar'}]},
    {name:'application',label:'Aplicación oficial',advanced:false},{name:'application_version',label:'Versión de la aplicación',advanced:false},{name:'line_custody',label:'Custodia de la línea (alias)',advanced:false},{name:'line_valid_until',label:'Vigencia conocida de la línea',type:'date',advanced:false},reason,
   ]} transform={({application,application_version,primary_availability,line_custody,line_valid_until,...body})=>({...version(body),inventory:{application,application_version,primary_availability,line_custody,line_valid_until}})}/>
  </Panel>
  <Notice>Los avisos a los días 10, 12, 13 y 14 son preventivos. No prueban que WhatsApp haya revocado una sesión.</Notice>
 </>}
 {section==='recovery'&&<>
  <Panel title="Recuperación controlada" description="Cada intento respeta pausas, propiedad de la sesión y permisos vigentes.">
   <dl className="session-facts"><div><dt>Recuperación automática</dt><dd>{s.recovery_enabled?'Configurada':'Desactivada'}</dd></div><div><dt>Intentos usados</dt><dd>{str(s.retry_count)} de 5</dd></div><div><dt>Respaldo WAHA verificado</dt><dd>{s.backup_verified_at?date(str(s.backup_verified_at)):'Sin evidencia de respaldo'}<small>{labels[str(s.backup_status)]??'Estado del respaldo sin confirmar'}</small></dd></div><div><dt>Etapa</dt><dd>{labels[str(s.recovery_stage)]??str(s.recovery_stage)}</dd></div></dl>
   {!!s.recovery_blocker&&<Notice>Recuperación detenida: {str(s.recovery_blocker)}. Revisa diagnóstico y pausas antes de continuar.</Notice>}
   <ResourceForm title="Configurar recuperación" trigger="Configurar recuperación" path={`${path}/session`} method="PATCH" initial={{...s,version:s.revision}} fields={[
    {name:'recovery_enabled',label:'Permitir recuperación de caídas confirmadas',type:'checkbox',advanced:false},
    {name:'desired_state',label:'Estado deseado',type:'select',required:true,options:[{value:'STOPPED',label:'Mantener detenida'},{value:'RUNNING',label:'Mantener conectada cuando esté permitido'}]},
    {name:'operational_pause',label:'Mantener pausada la recuperación',type:'checkbox',advanced:false},reason]} transform={version}/>
  </Panel>
  <Panel title="Revincular o reparar almacenamiento" description="Primero se concilian las operaciones inciertas. La preparación conserva historial, pausa la cuenta y requiere aislamiento antes de credenciales nuevas.">
   <ResourceForm title="Preparar recuperación de sesión" trigger="Preparar recuperación" path={`${path}/session/recovery`} fields={[{name:'action',label:'Qué necesitas recuperar',type:'select',required:true,options:[{value:'prepare_relink',label:'Revincular el mismo número'},{value:'request_storage_replacement',label:'Solicitar reemplazo de almacenamiento dañado'},{value:'open_incident',label:'Abrir incidente y pausar la cuenta'}]},reason]} transform={version}/>
   <p className="panel-copy">El reemplazo de un volumen requiere un administrador, cuarentena cifrada y prueba de aislamiento. Una copia restaurada puede necesitar un QR nuevo.</p>
  </Panel>
  {Array.isArray(s.uncertain_commands)&&s.uncertain_commands.length>0&&<Panel title="Operaciones pendientes de conciliación"><DataTable data={s.uncertain_commands as Row[]} columns={[{key:'type',title:'Operación'},{key:'status',title:'Estado'},{key:'error',title:'Diagnóstico'}]}/><ResourceForm title="Conciliar una operación" trigger="Registrar conciliación" path={`${path}/session/recovery`} fields={[{name:'command_id',label:'Operación',type:'select',required:true,options:(s.uncertain_commands as Row[]).filter(v=>v.status==='FAILED').map(v=>({value:v.id,label:`${v.type} · ${v.id.slice(0,8)}`}))},{name:'outcome',label:'Resultado comprobado',type:'select',required:true,options:[{value:'keep_unknown',label:'Aún desconocido'},{value:'confirmed_applied',label:'Se aplicó, con evidencia'},{value:'confirmed_not_applied',label:'No se aplicó, con evidencia'}]},reason]} transform={body=>({...version(body),action:'reconcile_command'})}/></Panel>}
  <Panel title="Alertas de esta cuenta"><DataTable data={(s.alerts??[]) as Row[]} columns={[{key:'kind',title:'Motivo'},{key:'status',title:'Entrega del aviso'},{key:'acknowledged_at',title:'Acuse humano',render:r=>r.acknowledged_at?date(str(r.acknowledged_at)):'Sin confirmar'},{key:'action',title:'Acción',render:r=>!r.acknowledged_at&&<ResourceForm title="Confirmar lectura del aviso" trigger="Confirmar lectura" path={`${path}/session/recovery`} fields={[reason]} transform={body=>({...version(body),action:'acknowledge_alert',alert_id:r.id})}/>}]} /></Panel>
  <details className="advanced-fields"><summary>Historial de observaciones y mantenimiento</summary><DataTable data={(s.history??[]) as Row[]} columns={[{key:'kind',title:'Acción'},{key:'source',title:'Fuente'},{key:'recorded_at',title:'Fecha',render:r=>date(r.recorded_at)}]}/></details>
 </>}
 </div>}</QueryState>;
}
