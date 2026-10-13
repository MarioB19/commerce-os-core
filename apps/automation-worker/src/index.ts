import {processWarmupSimulations} from './warmup-simulation.js';
import {processIntelligenceQueue} from '../../../packages/intelligence/src/index.js';
import {collectOperationalAlerts,deliverOperationalAlerts} from './operations-monitor.js';
import {processWarmup} from './warmup.js';
import {processProfileQrWarmup} from './profile-warmup.js';
import {PostgresJobBus,workerService} from '@commerce/jobs';
import {recoverAutomation,processInbound,processCommands,processSimulationScripts,processNewWorkflows,processTimers,processCampaigns,projectCampaignResults,processAgents,processReceiptAnalyses,materializeInboundMedia,materializeFailedInboundMedia} from './runtime.js';
import {processInsightJobs,scheduleRecentInsights} from './meta-insights.js';
import {materializeEffectResults} from './effect-results.js';
import {processVariantReceipts} from './variant-receipts.js';
import {numberLabRuntimeFromEnv,processNumberLabOperations} from './number-lab-runner.js';
import {processResultProjections} from './result-projection-runner.js';
import {randomUUID} from 'node:crypto';
import {AutomationLoopMonitor,automationLoopMetrics} from './loop-monitor.js';
import {persistAutomationHeartbeat} from './heartbeat.js';
import type {AutomationLoopName} from '../../../packages/domain/src/operations/automation-progress.js';
await recoverAutomation();
const monitor=new AutomationLoopMonitor(),instance=`automation-${randomUUID()}`;
function loop(name:AutomationLoopName,period:number,work:()=>Promise<unknown>){const observed=monitor.add(name,work),run=()=>observed.run().catch(()=>{process.stderr.write(`${name}_failed; durable facts preserved\n`);});let timer:ReturnType<typeof setInterval>|undefined;return{start:()=>{timer=setInterval(()=>void run(),period);void run();},stop:()=>{clearInterval(timer);observed.stop();}};}
// External AI calls and receipt analysis do not occupy the inbound/command scheduler.
const inbound=monitor.add('automation_inbound',async()=>{await processInbound(100);});
const commands=loop('automation_commands',250,()=>processCommands());
const materialize=loop('automation_results',250,async()=>{await materializeInboundMedia();await materializeFailedInboundMedia();await materializeEffectResults();});
const workflows=loop('automation_workflows',500,async()=>{await processSimulationScripts();await processNewWorkflows();await processTimers();});
const campaigns=loop('automation_campaigns',1000,async()=>{await processCampaigns();await projectCampaignResults();});
// LEGACY pools keep their global planner; V7 QR-continuous pools run per profile.
const warmup=loop('automation_warmup',30000,async()=>{await processWarmup();await processProfileQrWarmup();});
const warmupSimulation=loop('automation_warmup_simulation',500,()=>processWarmupSimulations());
const insights=loop('automation_meta_insights',5000,async()=>{await scheduleRecentInsights();await processInsightJobs();});
const operations=loop('operations_monitor',60000,async()=>{await collectOperationalAlerts();await deliverOperationalAlerts();});
const agents=loop('automation_agents',500,()=>processAgents());
const intelligence=loop('intelligence',5000,()=>processIntelligenceQueue());
const receipts=loop('automation_receipts',500,()=>processReceiptAnalyses());
// V7 F5: receipts of published variants, read with each variant's own grant and the business's key.
const variantReceipts=loop('automation_variant_receipts',1000,()=>processVariantReceipts());
// V7 F6 «Probar número»: only with the laboratory logins configured; otherwise a no-op.
const laboratory=(()=>{try{return numberLabRuntimeFromEnv();}catch(error){process.stderr.write(`number_lab_configuration_failed ${error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'UNEXPECTED'}\n`);return null;}})();
const numberLab=loop('number_lab',500,()=>processNumberLabOperations(laboratory));
// V7 F7: Resultados projections with the reviewed commerce_results login (no-op without it).
const resultProjections=loop('result_projections',60000,()=>processResultProjections());
const loops=[commands,materialize,workflows,campaigns,insights,agents,receipts,variantReceipts,numberLab,resultProjections,warmup,warmupSimulation,operations,intelligence];
for(const item of loops)item.start();
const service=await workerService('automation-worker',Number(process.env.PORT??process.env.AUTOMATION_PORT??3003),inbound.run,250,{progress:()=>monitor.snapshot(),metrics:()=>automationLoopMetrics(monitor.snapshot()),heartbeat:()=>persistAutomationHeartbeat(instance,monitor.snapshot())});
const bus=new PostgresJobBus();await bus.start();await bus.work('automation.wake',async()=>{await service.run();});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{inbound.stop();for(const item of loops)item.stop();void Promise.all([bus.stop(),service.close(),laboratory?.close()]).then(()=>process.exit(0));});
