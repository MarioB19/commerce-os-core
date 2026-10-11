import {flushWarmupSimulatedEvents,prepareWarmupSimulationAccounts} from './warmup-simulator.js';
import {prepareWarmupProfiles} from './warmup-profile.js';
import {downloadInboundMedia} from './media.js';
import {consumeProviderObservations} from './observations.js';
import {persistHeartbeat} from '@commerce/jobs';
import {dispatchOutbox,recoverSending,ownerId} from './dispatch.js';
import {processChannelCommands,recoverChannelCommands,heartbeatOwnership,collectHealth,recordHealth} from './lifecycle.js';
import {providerFor,type ProviderFactory} from './providers.js';
export * from './dispatch.js';export * from './lifecycle.js';export * from './providers.js';
let heartbeatAt=0;
export async function channelTick(factory:ProviderFactory=providerFor,owner=ownerId){if(Date.now()-heartbeatAt>15000){await persistHeartbeat('channel-worker',owner);heartbeatAt=Date.now();}await prepareWarmupSimulationAccounts(owner,account=>recordHealth(account,factory));await flushWarmupSimulatedEvents();await consumeProviderObservations();await downloadInboundMedia(10,factory);await heartbeatOwnership(owner);await processChannelCommands(10,factory,owner);await collectHealth(factory,owner);await prepareWarmupProfiles(factory,owner);await recoverSending();await recoverChannelCommands();await dispatchOutbox(20,factory,owner);}

export {consumeProviderObservations};

export {downloadInboundMedia};
