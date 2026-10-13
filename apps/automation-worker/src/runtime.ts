import {processWarmupSimulations} from './warmup-simulation.js';
import {collectOperationalAlerts,deliverOperationalAlerts} from './operations-monitor.js';
import {processWarmup} from './warmup.js';
import {openAiBudgets} from './ai-budgets.js';
import {processVariantReceipts} from './variant-receipts.js';
export {processWarmup} from './warmup.js';
import {processInsightJobs,scheduleRecentInsights} from './meta-insights.js';
import {processSimulationScripts} from './simulation.js';
import {materializeInboundMedia,materializeFailedInboundMedia} from './media.js';
import {query,withTransaction,getRecord} from '@commerce/db';
import {save,receiptReviewPending} from './shared.js';
import {materializeEffectResults} from './effect-results.js';
import {processCommands} from './commands.js';
import {processInbound} from './inbound.js';
import {processNewWorkflows,processTimers} from './workflows.js';
import {processAgents,processReceiptAnalyses} from './agents.js';
import {processCampaigns,projectCampaignResults} from './campaigns.js';
export * from './commands.js';export * from './inbound.js';export * from './workflows.js';export * from './agents.js';export * from './campaigns.js';
export async function automationTick(){await processWarmupSimulations();await processWarmup();await materializeInboundMedia();await materializeFailedInboundMedia();await materializeEffectResults();await processInbound();await processCommands();await processSimulationScripts();await processNewWorkflows();await processTimers();await processCampaigns();await projectCampaignResults();await processAgents();await processReceiptAnalyses();await processVariantReceipts();await scheduleRecentInsights();await processInsightJobs();await openAiBudgets();await collectOperationalAlerts();await deliverOperationalAlerts();}
export async function recoverAutomation(){await query(`UPDATE records SET body=body||jsonb_build_object('status','INTERRUPTED','reason','WORKER_RESTART'),version=version+1,updated_at=now() WHERE kind='ai_run' AND body->>'status'='RUNNING' AND (body->>'started_at')::timestamptz<now()-interval '90 seconds'`);
 const interrupted=(await query(`SELECT * FROM records WHERE kind='receipt' AND body->>'analysis_status'='RUNNING' AND (body->>'analysis_started_at')::timestamptz<now()-interval '90 seconds'`)).rows;
 for(const candidate of interrupted)await withTransaction(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[candidate.body.conversation_id]);const receipt=await getRecord(c,candidate.workspace_id,'receipt',candidate.id);if(!receipt||receipt.body.analysis_status!=='RUNNING'||receipt.body.review||Date.parse(receipt.body.analysis_started_at)>=Date.now()-90_000||await receiptReviewPending(c,receipt))return;await save(c,receipt,{...receipt.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:'WORKER_RESTART_DURING_ANALYSIS'});});
}

export {materializeInboundMedia,materializeFailedInboundMedia};

export {processSimulationScripts};
