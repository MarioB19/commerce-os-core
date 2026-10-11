/** Shared UI request contract; restore is the inverse of the archive flag. */
export function retirementRequest(kind:'workflows'|'agents',id:string,input:{expected_version:number;reason:string;currently_archived:boolean;dependency_hash?:string;handoff?:boolean}){
 const {currently_archived,expected_version,reason,dependency_hash,handoff}=input;
 return {path:`/${kind}/${id}/archive`,body:{expected_version,reason,archived:!currently_archived,...(!currently_archived?{dependency_hash,...(handoff?{existing_policy:'handoff' as const}:{})}:{})}};
}
