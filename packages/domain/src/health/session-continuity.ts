/** No message, heartbeat or provider connection is evidence of primary-device use. */
export function primaryMaintenance(used: string | Date | null, now = new Date()) {
 const at=used?new Date(used).getTime():NaN;
 if(!Number.isFinite(at)||at>now.getTime())return {status:'UNKNOWN',days:null,next_due_at:null};
 const days=Math.floor((now.getTime()-at)/86400000);
 return {status:days>=14?'OVERDUE':days>=13?'DUE_13':days>=12?'DUE_12':days>=10?'DUE_10':'CURRENT',days,next_due_at:new Date(at+7*86400000).toISOString()};
}
export function normalizeSession(raw:unknown,identity:boolean,conflict=false){
 const state=typeof raw==='string'&&['STOPPED','STARTING','WORKING','SCAN_QR_CODE','FAILED','PASSKEY_REQUIRED','PASSKEY_CONFIRMATION_REQUIRED'].includes(raw)?raw:'UNKNOWN';
 if(conflict)return {observed_state:'UNKNOWN',auth_state:'IDENTITY_CONFLICT',raw_state:state};
 if(state.startsWith('PASSKEY'))return{observed_state:'UNKNOWN',auth_state:'PASSKEY_REQUIRED',raw_state:state};
 return {observed_state:state==='WORKING'&&identity?'CONNECTED':state==='SCAN_QR_CODE'?'QR_REQUIRED':['STOPPED','STARTING'].includes(state)?state:'UNKNOWN',auth_state:state==='WORKING'&&identity?'VERIFIED':state==='SCAN_QR_CODE'?'QR_REQUIRED':'UNKNOWN',raw_state:state};
}
export const retryDelays=[5,15,45,120,300];
export function retryDelay(attempt:number,random=Math.random){return Math.round((retryDelays[attempt]??300)*1000*(.9+.2*random()));}
