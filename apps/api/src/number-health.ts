import type {FastifyInstance} from 'fastify';
import {numberHealth} from '../../../packages/db/src/number-health.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,scopedRecord} from './context.js';
import {channelReception,channelHistoryRoutes} from './channel-reception.js';
import {withOperationalReadBudget} from './operational-read-budget.js';
export async function numberHealthRoutes(app:FastifyInstance){await channelHistoryRoutes(app);app.get('/v1/channel-accounts/:id/health',async(req,reply)=>{reply.header('Cache-Control','no-store');const p=principal(req);assertPermission(p,p.service?'channels:read':'sales:read');return withOperationalReadBudget(async c=>{const a=await scopedRecord(req,'channel_account',(req.params as {id:string}).id,c),now=await numberNow(c,p.workspace_id,a.environment);return{data:{...await numberHealth(c,a,now),reception:await channelReception(c,a)}};});});}
