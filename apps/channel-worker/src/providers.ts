import {numberSimulator} from './number-simulator.js';
import {warmupSimulator} from './warmup-simulator.js';
import {catalogSimulator} from './catalog-simulator.js';
import type {DomainRecord,Environment} from '@commerce/contracts';
import {WahaProvider,CloudProvider,SimulatorProvider,type MessagingProvider} from '@commerce/messaging';
import {pool,type QueryExecutor} from '@commerce/db';
import {readIntegrationSettings,validateIntegrationConfig} from '../../../packages/db/src/integration-settings.js';
import {SimulatedFulfillmentProvider,WebhookFulfillmentProvider,type FulfillmentProvider} from '../../../packages/fulfillment/src/index.js';
import {publicEndpointFetch} from '../../../packages/fulfillment/src/public-fetch.js';
export type ProviderFactory=(account:DomainRecord)=>MessagingProvider|Promise<MessagingProvider>;
const simulations=new Map<string,SimulatorProvider>();
export function accountIntegrationKey(account:DomainRecord){return `${account.body.provider}:${String(account.body.gateway_ref??String(account.body.provider).toUpperCase())}`;}
/** Endpoint/session ownership is global, without reading other workspaces' secrets. */
export async function assertGatewayIsolation(account:DomainRecord,client:QueryExecutor=pool) {
 if(account.environment!=='REAL'||account.body.provider!=='waha')return;
 const ref=String(account.body.gateway_ref??'WAHA'),session=String(account.body.session??'default');
 const profile=await readIntegrationSettings(client,account.workspace_id,account.environment,`waha:${ref}`,{secrets:false});const url=profile?.config.base_url;
 const others=(await client.query("SELECT r.body,s.config FROM records r LEFT JOIN integration_settings s ON s.workspace_id=r.workspace_id AND s.environment=r.environment AND s.key='waha:'||COALESCE(r.body->>'gateway_ref','WAHA') WHERE r.kind='channel_account' AND NOT (r.body ? 'deleted_at') AND r.environment='REAL' AND r.body->>'provider'='waha' AND r.id::text<>$1",[account.id])).rows;
 if(others.some(other=>String(other.body.session??'default')===session&&(!!url&&other.config?.base_url===url)))throw new Error('CHANNEL_GATEWAY_ALREADY_ASSIGNED');
}
/** V7 F1 (ADR-V7-08): INGRESS_RELAY_URL is the private Cloud Run relay base
 * (https://…/relay/<token>); absent, WAHA calls only the host ingress. */
function relayTarget(account:DomainRecord){
 const base=process.env.INGRESS_RELAY_URL;if(!base||account.environment!=='REAL')return {};
 return {relayUrl:`${base.replace(/\/$/,'')}/waha/${encodeURIComponent(account.workspace_id)}/${encodeURIComponent(account.id)}`};
}
export async function providerFor(account:DomainRecord):Promise<MessagingProvider> {
 const kind=account.body.provider;if(account.environment==='SIMULATION'&&kind!=='simulator')throw new Error('SIMULATION_EXTERNAL_PROVIDER_DENIED');
 if(kind==='simulator'&&account.body.simulation_run_id)return warmupSimulator(account);
 if(kind==='simulator'&&account.body.device_ref)return numberSimulator(account);
 if(kind==='simulator'){if(account.environment!=='SIMULATION')throw new Error('SIMULATOR_REAL_ENVIRONMENT_DENIED');const laboratory=account.body.lab_snapshot===true||account.body.flow_test_transport==='ISOLATED_SIMULATOR';const key=`${account.id}:${account.body.simulated_fault??'WORKING'}:${laboratory}`;let provider=simulations.get(key);if(!provider){provider=laboratory?catalogSimulator(account):new SimulatorProvider(account.body.simulated_fault==='UNKNOWN'?'AMBIGUOUS':account.body.simulated_fault==='FAILED'?'FAILED':'WORKING');simulations.set(key,provider);}return provider;}
 if(kind!=='waha'&&kind!=='cloud')throw new Error('PROVIDER_UNSUPPORTED');
 const profile=await readIntegrationSettings(pool,account.workspace_id,account.environment,accountIntegrationKey(account));if(!profile?.enabled)throw new Error('PROVIDER_CONFIGURATION_REQUIRED_PROFILE');const config=validateIntegrationConfig(kind,profile.config,true);const secret=(field:string)=>{const value=profile.secrets[field];if(!value)throw new Error('PROVIDER_CONFIGURATION_REQUIRED_SECRET');return value;};
 if(kind==='waha')return new WahaProvider({baseUrl:String(config.base_url),apiKey:secret('api_key'),session:account.body.session??'default',engine:account.body.engine==='NOWEB'?'NOWEB':account.body.engine==='WEBJS'?'WEBJS':'GOWS',webhook:{url:`${process.env.INTERNAL_INGRESS_URL??'http://ingress:3002'}/webhooks/waha/${account.workspace_id}/${account.id}`,hmacKey:secret('webhook_secret'),...relayTarget(account)}});
 return new CloudProvider({token:secret('token'),phoneNumberId:String(config.phone_number_id),graphVersion:String(config.graph_version)});
}
export async function fulfillmentProviderFor(workspace:string,environment:Environment):Promise<FulfillmentProvider>{if(environment==='SIMULATION')return new SimulatedFulfillmentProvider();const profile=await readIntegrationSettings(pool,workspace,environment,'fulfillment:default');if(!profile?.enabled||!profile.secrets.token)throw new Error('FULFILLMENT_CONFIGURATION_REQUIRED');const config=validateIntegrationConfig('fulfillment',profile.config,true);const endpoint=String(config.endpoint);return new WebhookFulfillmentProvider({endpoint,allowedOrigin:new URL(endpoint).origin,token:profile.secrets.token,fetcher:publicEndpointFetch});}
