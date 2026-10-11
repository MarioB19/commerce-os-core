import type {Body,DomainRecord} from '@commerce/contracts';
import {getRecord,hash,stableJson,type QueryExecutor} from '@commerce/db';
import {activeAt,listAssignments} from '../../../packages/db/src/commercial-assignments.js';

export async function numberFlowSourceState(c:QueryExecutor,test:DomainRecord){
 const reasons:string[]=[],sourceId=String(test.body.source?.account?.id??'');
 const account=sourceId?await getRecord(c,test.workspace_id,'channel_account',sourceId):undefined;
 if(!account||account.environment!=='REAL'||account.body.deleted_at)reasons.push('SOURCE_ACCOUNT_MISSING');
 else if(account.version!==Number(test.body.source?.account?.version)||hash(stableJson(account.body))!==test.body.source?.account?.content_hash)reasons.push('SOURCE_ACCOUNT_CHANGED');
 const now=new Date().toISOString();
 const assignments=sourceId?(await listAssignments(c,test.workspace_id,'REAL',{account_id:sourceId,status:'ACTIVE'})).filter(candidate=>activeAt(candidate,now)):[];
 const manifestHash=hash(stableJson(assignments.map(item=>({id:item.id,revision:item.revision,binding_id:item.binding_id,body:item.body}))));
 if(manifestHash!==test.body.source?.assignment_manifest_hash)reasons.push('ASSIGNMENTS_CHANGED');
 return{freshness:reasons.length?'STALE':'CURRENT',stale_reasons:reasons,current_version:account?.version??null,current_assignment_manifest_hash:manifestHash,current_assignment_count:assignments.length} as Body;
}
