export const numberStateLabels={ATTENTION:'Necesita atención',PAUSED:'En pausa',DISCONNECTED:'Sin conexión',PENDING:'Comprobación pendiente',PREPARE:'Falta preparar',READY_TO_WARM:'Listo para calentar',WARMING:'Calentando',PREPARED:'Preparación completada',READY_TO_SELL:'Listo para vender'} as const;
export type NumberState=keyof typeof numberStateLabels;
export function numberState(input:{restricted:boolean;identityConflict:boolean;paused:boolean;connection:'CONNECTED'|'DISCONNECTED'|'PENDING';ownership:boolean;prepared:boolean;warming:boolean;reviewed:boolean;sales:{ready:boolean;name:string}[]}){
 const count=input.sales.filter(s=>s.ready).length;
 const state:NumberState=input.restricted||input.identityConflict?'ATTENTION':input.paused?'PAUSED':input.connection==='DISCONNECTED'?'DISCONNECTED':input.connection==='PENDING'?'PENDING':!input.ownership?'ATTENTION':count>0&&input.prepared?'READY_TO_SELL':input.prepared?'PREPARED':input.warming?'WARMING':input.reviewed?'READY_TO_WARM':'PREPARE';
 const text=state==='READY_TO_SELL'&&count<input.sales.length?`Disponible en ${count} de ${input.sales.length} productos`:numberStateLabels[state];
 const action={ATTENTION:'review_health',PAUSED:'review_pause',DISCONNECTED:'connect',PENDING:'check_connection',PREPARE:'prepare',READY_TO_WARM:'review_activation',WARMING:'progress',PREPARED:'review_products',READY_TO_SELL:'view_products'}[state];
 return{primary_state:state,reason_text:text,next_action:{code:action,label:{review_health:'Revisar salud',review_pause:'Revisar pausa',connect:'Conectar',check_connection:'Comprobar conexión',prepare:'Completar preparación',review_activation:'Revisar y activar',progress:'Ver progreso',review_products:'Revisar productos',view_products:'Ver productos'}[action]},algorithm_version:'numbers/v1'};
}
export function maskedAlias(value:string){return value.replace(/\+?\d[\d ()-]{8,}\d/g,v=>'•••• '+v.replace(/\D/g,'').slice(-4));}
