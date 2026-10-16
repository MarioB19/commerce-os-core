import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool} from '@commerce/db';
import {readPreparation} from '../../../packages/db/src/preparation.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,scopedRecord,sanitize} from './context.js';
import {capacityRoutes} from './number-capacity.js';
import {numberLinkRoutes} from './number-link.js';

/** V7 F8-D: the number journey of the V7 application and MCP (RF-07,
 * wireframe D) plus the warm-up reads and the platform capacity agent. The V5
 * number administration, programs, library, groups and simulator routes were
 * retired with their screens and service-token tools. */
const idOf=(req:FastifyRequest)=>z.object({id:z.string().uuid()}).parse(req.params).id;
function numberPermit(req:FastifyRequest,write=false){const p=principal(req);assertPermission(p,p.service?write?'channels:manage':'channels:read':write?'channels:manage':'sales:read');return p;}
export async function numbersRoutes(app:FastifyInstance){
 await numberLinkRoutes(app);await capacityRoutes(app);
 app.get('/v1/numbers/:id/episodes',async req=>{numberPermit(req);const a=await scopedRecord(req,'channel_account',idOf(req));return{data:sanitize((await pool.query('SELECT id,version,policy_version,started_at,completed_at,closed_at,historical_evidence FROM warmup_episodes WHERE account_id=$1 AND workspace_id=$2 AND environment=$3 ORDER BY started_at DESC',[a.id,a.workspace_id,a.environment])).rows)};});
 app.get('/v1/numbers/:id/preparation',async req=>{numberPermit(req);const a=await scopedRecord(req,'channel_account',idOf(req)),result=await readPreparation(pool,a.workspace_id,a.environment,a.id);const {state:_state,...data}=result;return{data:sanitize(data)};});
}
