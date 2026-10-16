import pg from 'pg';
/** V7: the dedicated commerce_ai login used for every AI call made with a
 * business's own key (seller and receipts). Absent configuration means no AI:
 * conversations and receipts go to a person instead. */
let aiPool:pg.Pool|null|undefined;
export function profileAiPool(){
 if(aiPool!==undefined)return aiPool;
 const url=process.env.AI_DATABASE_URL;if(!url){aiPool=null;return null;}
 aiPool=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
 aiPool.on('connect',client=>{client.query('SET ROLE commerce_ai').catch(()=>{process.stderr.write('ai_runtime_role_not_assumed\n');});});
 return aiPool;
}
