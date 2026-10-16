import {refreshActiveNumberGroups} from './number-group-observation.js';
import {processNumberOperations} from './number-operations.js';
import {discoverSessionOwnership} from './lifecycle.js';
import {superviseSessions} from './session-supervisor.js';
import {prepareWarmupSimulationAccounts,flushWarmupSimulatedEvents} from './warmup-simulator.js';
import {prepareWarmupProfiles} from './warmup-profile.js';
import {PostgresJobBus} from '@commerce/jobs';
import {buildChannelServer} from './server.js';
import {ChannelLoopMonitor} from './loop-monitor.js';
import {persistChannelHeartbeat} from './heartbeat.js';
import {runChannelProfileMaintenance} from './profile-maintenance.js';
import {dispatchOutbox,recoverSending,recoverChannelCommands,processChannelCommands,heartbeatOwnership,collectHealth,recordHealth,consumeProviderObservations,downloadInboundMedia,ownerId} from './runtime.js';
const monitor=new ChannelLoopMonitor(),app=await buildChannelServer(undefined,monitor);await recoverSending();await recoverChannelCommands();
function loop(name:string,period:number,work:()=>Promise<unknown>,deadlineMs=180_000,required=true){const observed=monitor.add(name,work,{deadlineMs,required});const timer=setInterval(()=>void observed.run(),period);void observed.run();return{run:observed.run,stop:()=>{clearInterval(timer);observed.stop();}};}
// A slow gateway health read, media GET or lifecycle operation cannot occupy the dispatch scheduler.
const dispatch=loop('channel_dispatch',500,()=>dispatchOutbox(100));
const observations=loop('channel_observations',500,()=>consumeProviderObservations());
const warmupSimulation=loop('channel_warmup_simulation',500,async()=>{await prepareWarmupSimulationAccounts(ownerId,account=>recordHealth(account));await flushWarmupSimulatedEvents();},180_000,false);
const numberGroups=loop('number_group_observation',15000,()=>refreshActiveNumberGroups(ownerId),180_000,false);
const numberOperations=loop('number_operations',2000,()=>processNumberOperations(ownerId));
const commands=loop('channel_commands',500,()=>processChannelCommands(),360_000);
const media=loop('channel_media',1000,()=>downloadInboundMedia(),300_000);
const supervisor=loop('channel_session_supervisor',5000,()=>superviseSessions());
const health=loop('channel_health',15000,()=>collectHealth());
const profiles=loop('channel_warmup_profiles',60000,()=>prepareWarmupProfiles(),180_000,false);
// Discovery or reconciliation may wait on one account. Neither may delay the
// heartbeat of other generations already owned by this process.
const ownership=loop('channel_ownership',15000,()=>heartbeatOwnership(),45_000);
const discovery=loop('channel_ownership_discovery',15000,()=>discoverSessionOwnership(),180_000,false);
const maintenance=loop('channel_maintenance',15000,async()=>{await recoverSending();await recoverChannelCommands();},60_000);
const heartbeat=loop('channel_heartbeat',15000,()=>persistChannelHeartbeat(ownerId,monitor.snapshot()),45_000,false);
// V7 F3: per-profile expiry cancellation and QR continuity registration (WorkerScope).
const profileMaintenance=loop('channel_profile_maintenance',60000,()=>runChannelProfileMaintenance(),180_000,false);
const bus=new PostgresJobBus();await bus.start();await bus.work('channel.wake',dispatch.run);await app.listen({host:process.env.HOST??'0.0.0.0',port:Number(process.env.PORT??process.env.CHANNEL_PORT??3004)});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{for(const item of [dispatch,observations,commands,media,health,maintenance,profiles,profileMaintenance,warmupSimulation,supervisor,numberOperations,numberGroups,ownership,discovery,heartbeat])item.stop();void Promise.all([bus.stop(),app.close()]).then(()=>process.exit(0));});
