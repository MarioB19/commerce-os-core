/** One bounded synthetic Responses request. No customer content or tools. */
export function diagnosticRequest(model:string){return {model,instructions:'Return only the requested JSON. This is a synthetic connectivity test.',input:'Return {"ok":true}.',max_output_tokens:128,store:false,text:{format:{type:'json_schema',name:'connection_check',strict:true,schema:{type:'object',properties:{ok:{type:'boolean',enum:[true]}},required:['ok'],additionalProperties:false}}}};}
export function diagnosticUsage(value:any,rates:{input:number;output:number}){
 const input=value?.input_tokens,output=value?.output_tokens;
 if(!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0)return null;
 return {input_tokens:input,output_tokens:output,total_tokens:input+output,cost_usd:Math.ceil((input*rates.input+output*rates.output)*1e6/1e6)/1e6};
}
export function classifyDiagnosticHttp(status:number,code?:string){
 if(status===401)return {status:'FAILED',code:'CREDENTIAL_REJECTED',next:'Revisa la clave del perfil.',uncertain:false};
 if(status===403)return {status:'FAILED',code:'PERMISSION_DENIED',next:'Comprueba permisos del proyecto y modelo.',uncertain:false};
 if(status===429)return {status:'FAILED',code:code==='insufficient_quota'?'PROVIDER_QUOTA_EXCEEDED':'PROVIDER_RATE_LIMITED',next:code==='insufficient_quota'?'Revisa la cuota de la cuenta.':'Espera el límite temporal y verifica la cuota; esta señal no prueba falta de saldo.',uncertain:false};
 if([400,404,422].includes(status))return {status:'FAILED',code:'MODEL_OR_FORMAT_INCOMPATIBLE',next:'Revisa modelo, endpoint y formato estructurado.',uncertain:false};
 return {status:'UNKNOWN',code:'PROVIDER_RESULT_UNKNOWN',next:'Consulta el diagnóstico antes de reintentar; se conserva la reserva.',uncertain:true};
}
export function validateDiagnosticResponse(value:any){
 if(value?.status!=='completed'||value?.error)return {verified:false,code:'INFERENCE_INCOMPLETE'};
 const contents=(Array.isArray(value.output)?value.output:[]).flatMap((x:any)=>Array.isArray(x.content)?x.content:[]);
 if(contents.some((x:any)=>x.type==='refusal'))return {verified:false,code:'INFERENCE_REFUSED'};
 try{const parsed=JSON.parse(contents.filter((x:any)=>x.type==='output_text').map((x:any)=>x.text).join(''));return {verified:parsed?.ok===true&&Object.keys(parsed).length===1,code:parsed?.ok===true?'SYNTHETIC_INFERENCE_VERIFIED':'INFERENCE_OUTPUT_INVALID'};}catch{return {verified:false,code:'INFERENCE_OUTPUT_INVALID'};}
}
