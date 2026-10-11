import {integrationPatchSchema,splitIntegrationKey,validateIntegrationConfig,validateIntegrationSecrets,type IntegrationPatch} from './integration-settings.js';
export type LegacyEnv=Record<string,string>;
export function isLegacyIntegrationVariable(key:string){if(/^(?:DATABASE_|DB_|BETTER_AUTH_|BOOTSTRAP_|INTERNAL_|CHANNEL_INTERNAL_|SIMULATOR_|ASSET_|PRIVATE_|DATA_ENCRYPTION|ENCRYPTION_KEY|BACKUP_|TRUSTED_|COMMERCE_|POSTGRES_|JOB_)/.test(key))return false;return /^(?:WORKSPACE_ID|META_WORKSPACE_ID|META_ACCOUNT_KEYS|META_ACCESS_TOKEN|META_ACCOUNT_[A-Z0-9_]+_ACCESS_TOKEN|OPENAI_API_KEY|OPENAI_BASE_URL|AI_INPUT_COST_PER_MILLION_MINOR|AI_OUTPUT_COST_PER_MILLION_MINOR|FULFILLMENT_GRANT_URL|FULFILLMENT_GRANT_TOKEN|[A-Z][A-Z0-9_]*_(?:URL|API_KEY|WEBHOOK_SECRET|TOKEN|PHONE_NUMBER_ID|GRAPH_VERSION|APP_SECRET|VERIFY_TOKEN))$/.test(key);}
/** Only an installer calls this one-time planner; runtimes never consult these variables. */
export function planLegacyIntegrations(env:LegacyEnv,workspace:string){
 if(!workspace||env.WORKSPACE_ID&&env.WORKSPACE_ID!==workspace||env.META_WORKSPACE_ID&&env.META_WORKSPACE_ID!==workspace)throw new Error('LEGACY_WORKSPACE_MISMATCH');
 const profiles:{key:string;patch:IntegrationPatch}[]=[];
 const add=(key:string,config:Record<string,string|number>,secrets:Record<string,string>,enabled=true)=>{const{type}=splitIntegrationKey(key);const patch=integrationPatchSchema.parse({expected_version:0,label:'Conexión importada · '+key,enabled,config,secrets,clear_secrets:[],reason:'Importación privada inicial; revisar operación antes de habilitar envíos.'});validateIntegrationConfig(type,config,enabled);validateIntegrationSecrets(type,secrets,enabled);profiles.push({key,patch});};
 const aliases=(env.META_ACCOUNT_KEYS??'').split(/[\s,]+/).filter(Boolean),seen=new Set<string>();
 for(const alias of aliases.length?aliases:['principal']){const token=aliases.length?env[`META_ACCOUNT_${alias.toUpperCase().replace(/[^A-Z0-9]/g,'_')}_ACCESS_TOKEN`]:env.META_ACCESS_TOKEN;if(aliases.length&&!token)throw new Error('LEGACY_META_TOKEN_REQUIRED');if(token&&!seen.has(token)){seen.add(token);add('meta:'+alias,{}, {access_token:token});}}
 if(aliases.length&&!profiles.some(p=>p.key.startsWith('meta:')))throw new Error('LEGACY_META_TOKEN_REQUIRED');
 if(env.OPENAI_API_KEY){const input=Number(env.AI_INPUT_COST_PER_MILLION_MINOR??0),output=Number(env.AI_OUTPUT_COST_PER_MILLION_MINOR??0);add('openai:default',{base_url:env.OPENAI_BASE_URL??'https://api.openai.com/v1',input_cost_per_million_minor:input,output_cost_per_million_minor:output},{api_key:env.OPENAI_API_KEY},input>0&&output>0);}
 for(const key of Object.keys(env).sort()){
  if(key.endsWith('_WEBHOOK_SECRET')){const ref=key.slice(0,-'_WEBHOOK_SECRET'.length),api=env[ref+'_API_KEY'],url=env[ref+'_URL'];if(api&&url)add('waha:'+ref,{base_url:url},{api_key:api,webhook_secret:env[key]!});else if(api||url)throw new Error('LEGACY_GATEWAY_CONFIGURATION_INCOMPLETE');}
  if(key.endsWith('_PHONE_NUMBER_ID')){const ref=key.slice(0,-'_PHONE_NUMBER_ID'.length),secrets={token:env[ref+'_TOKEN']??'',app_secret:env[ref+'_APP_SECRET']??'',verify_token:env[ref+'_VERIFY_TOKEN']??''};add('cloud:'+ref,{phone_number_id:env[key]!,graph_version:env[ref+'_GRAPH_VERSION']??'v26.0'},secrets);}
 }
 if(env.FULFILLMENT_GRANT_URL&&env.DELIVERY_GATEWAY_URL&&env.FULFILLMENT_GRANT_URL!==env.DELIVERY_GATEWAY_URL||env.FULFILLMENT_GRANT_TOKEN&&env.DELIVERY_GATEWAY_TOKEN&&env.FULFILLMENT_GRANT_TOKEN!==env.DELIVERY_GATEWAY_TOKEN)throw new Error('LEGACY_DELIVERY_CONFIGURATION_CONFLICT');
 const endpoint=env.FULFILLMENT_GRANT_URL??env.DELIVERY_GATEWAY_URL,token=env.FULFILLMENT_GRANT_TOKEN??env.DELIVERY_GATEWAY_TOKEN;if(endpoint||token)add('fulfillment:default',{endpoint:endpoint??''},{token:token??''});
 return profiles;
}
