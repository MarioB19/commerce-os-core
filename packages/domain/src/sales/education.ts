export type EducationSelection={nivel?:'preescolar'|'primaria'|'ambos';grado?:string;education_role?:'multigrado'|'directivo'|'sin_grupo';valid:boolean;clarification?:string};
const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
/** Deterministic routing only; it does not infer pedagogical fit or unlock access. */
export function classifyEducation(text:string,previous:Record<string,unknown>={}):EducationSelection {
 const value=normalize(text);const preschool=/\b(preescolar|kinder|jardin de ninos)\b/.test(value),primary=/\bprimaria\b/.test(value);
 const nivel=preschool&&primary?'ambos':preschool?'preescolar':primary?'primaria':['preescolar','primaria','ambos'].includes(String(previous.nivel))?previous.nivel as EducationSelection['nivel']:undefined;
 const role=/\b(multigrado|varios grados|todos los grados|los tres|los seis)\b/.test(value)?'multigrado':/\b(director|directora|directivo|directiva)\b/.test(value)?'directivo':/\b(sin grupo|no tengo grupo|aun no|todavia no|por definir)\b/.test(value)?'sin_grupo':undefined;
 if(role)return{valid:true,nivel,education_role:role,grado:role==='multigrado'?'multigrado':role==='directivo'?'direccion':'sin_definir'};
 const words=['primer(?:o|a)?','segund[oa]','tercer(?:o|a)?','cuart[oa]','quint[oa]','sext[oa]'];
 const grades=words.flatMap((word,index)=>new RegExp(`\\b(?:${word}|${index+1}(?:[.°ºªo]|ro|do|to)?)(?:\\b|$)`).test(value)?[index+1]:[]);
 const previousGrade=typeof previous.grado==='string'&&/^[1-6]$/.test(previous.grado)?Number(previous.grado):undefined;
 const grade=grades.length===1?grades[0]:!grades.length?previousGrade:undefined;
 if(!nivel)return{valid:false,...(grade?{grado:String(grade)}:{}),clarification:'¿Es preescolar o primaria? Así te ubico en el nivel correcto 💛'};
 if(nivel==='ambos'||grades.length>1)return{valid:true,nivel,grado:'multigrado',education_role:'multigrado'};
 if(!grade||nivel==='preescolar'&&grade>3)return{valid:false,nivel,clarification:nivel==='preescolar'?'¿Primero, segundo o tercero de preescolar? También puedes decirme si trabajas con multigrado.':'¿Qué grado de primaria: primero, segundo, tercero, cuarto, quinto o sexto? También puedes decirme si trabajas con multigrado.'};
 return{valid:true,nivel,grado:String(grade)};
}
export function collectionStopReason(text:string):string|undefined {
 const value=normalize(text).replace(/[!¡¿?.,]+/g,' ').replace(/\s+/g,' ').trim();
 if(/^(stop|baja|no me escribas|cancelar suscripcion|no quiero recibir mensajes)$/.test(value))return'CONTACT_OPT_OUT';
 if(/\b(no me interesa|no lo quiero|no quiero (?:el|mi|este)|no voy a pagar|no era para mi|ya no quiero|dejame de escribir)\b/.test(value)||/^(no|no gracias)$/.test(value))return'CUSTOMER_DECLINED';
 if(/\b(pago|pagare|deposito|depositare|transfiero)\b.*\b(manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|quincena|proxima semana|el dia)\b/.test(value))return'PAYMENT_DATE_REQUIRES_REVIEW';
 return undefined;
}
