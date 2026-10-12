import {randomBytes,randomUUID} from 'node:crypto';
import type {ProfilePool} from './profile-context.js';
import {describe,it,expect} from 'vitest';
import {sealLabValue,openLabValue,NumberLabWorkerStore,type LabCipherBinding} from './number-laboratory.js';
const binding=():LabCipherBinding=>({workspaceId:'historical-profile-α',runId:randomUUID(),purpose:'action',operationId:randomUUID()});
describe('laboratory encrypted storage scope',()=>{
 it('round-trips Unicode with random nonces and no plaintext',()=>{const b=binding(),k=randomBytes(32),v={type:'message',text:'Prueba sintética 😀'};const a=sealLabValue(b,v,k),c=sealLabValue(b,v,k);expect(a).not.toEqual(c);expect(JSON.stringify(a)).not.toContain(v.text);expect(openLabValue(b,a,k)).toEqual(v);});
 it.each(['workspaceId','runId','operationId','purpose'] as const)('rejects moving ciphertext across %s',field=>{const b=binding(),k=randomBytes(32),v=sealLabValue(b,{text:'synthetic'},k);const altered={...b,[field]:field==='purpose'?'result':field==='workspaceId'?'other':randomUUID()};expect(()=>openLabValue(altered,v,k)).toThrow('LAB_CIPHER_INVALID');});
 it('rejects corruption, extra fields, a wrong key and wrong nonce length',()=>{const b=binding(),k=randomBytes(32),v=sealLabValue(b,{n:1},k);for(const bad of [{...v,iv:'AAAA'},{...v,extra:true},{...v,tag:'A'.repeat(22)+'=='},{...v,ciphertext:'AAAA'}])expect(()=>openLabValue(b,bad,k)).toThrow('LAB_CIPHER_INVALID');expect(()=>openLabValue(b,v,randomBytes(32))).toThrow('LAB_CIPHER_INVALID');});
 it('rejects absent operation identity and oversized content before encryption',()=>{const b=binding();expect(()=>sealLabValue({...b,operationId:undefined},{},randomBytes(32))).toThrow('LAB_CIPHER_SCOPE');expect(()=>sealLabValue(b,'x'.repeat(8388608),randomBytes(32))).toThrow('LAB_CONTENT_LIMIT');});
});

describe('immutable laboratory settlement replay',()=>{
 it.each(['RUNNING','STOPPED'] as const)('compares adopted run state for replay %s, without consulting later run state',async requested=>{
  const b={...binding(),purpose:'result' as const},key=randomBytes(32),result={message:'stored'},statements:string[]=[];
  const row={id:b.operationId,run_id:b.runId,workspace_id:b.workspaceId,state:'APPLIED',expected_version:1,created_at:new Date(),result_ciphertext:sealLabValue(b,{schema_version:1,run_state:'RUNNING',result},key)};
  const pool:ProfilePool={async connect(){return{query:async(sql)=>{statements.push(sql);if(sql.includes('commerce_number_lab.runs'))throw Error('MUST_NOT_READ_LATER_RUN');return{command:sql==='COMMIT'?'COMMIT':'SELECT',rowCount:1,oid:0,fields:[],rows:(sql.includes('FROM commerce_number_lab.operations')?[row]:[]) as any[]};},release(){}};}};
  const promise=new NumberLabWorkerStore(pool,key).finish(b.workspaceId,b.runId,b.operationId!,{state:'APPLIED',runState:requested,result});
  if(requested==='RUNNING'){expect(await promise).toMatchObject({result});expect(statements).toContain('COMMIT');}
  else{await expect(promise).rejects.toThrow('LAB_OPERATION_REPLAY');expect(statements).toContain('ROLLBACK');}
 });
});
