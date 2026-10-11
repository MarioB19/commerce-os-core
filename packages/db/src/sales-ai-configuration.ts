import type { Body, Environment } from '../../contracts/src/index.js';
import type { AgentConfig } from '../../domain/src/sales/ai.js';
import { readIntegrationSettings, validateIntegrationConfig } from './integration-settings.js';
import type { QueryExecutor } from './index.js';

/** Only the Sales connection is consulted. Creative/Intelligence are never fallbacks. */
export async function salesAiConfiguration(client:QueryExecutor,workspace:string,environment:Environment,stored:Body) {
  if(stored.provider==='deterministic')return {configured:true,state:'DETERMINISTIC_TEST_DOUBLE',agent:stored as AgentConfig};
  const profile=await readIntegrationSettings(client,workspace,environment,'openai:default',{secrets:false});
  if(!profile?.enabled||!profile.secret_fields.api_key)return {configured:false,state:'PROVIDER_PENDING'};
  let config;try{config=validateIntegrationConfig('openai',profile.config,true);}catch{return {configured:false,state:'PRICING_PENDING'};}
  const inherited=stored.provider==='workspace';
  const model=inherited?config.model:stored.model;
  const limit=inherited?config.max_cost_minor:stored.max_cost_minor;
  if(typeof model!=='string'||!model.trim())return {configured:false,state:'MODEL_PENDING'};
  if(!Number.isInteger(limit)||Number(limit)<=0)return {configured:false,state:'BUDGET_PENDING'};
  const agent:AgentConfig={...stored,provider:'openai',model,max_cost_minor:Number(limit),input_cost_per_million_minor:inherited?Number(config.input_cost_per_million_minor):stored.input_cost_per_million_minor??Number(config.input_cost_per_million_minor),output_cost_per_million_minor:inherited?Number(config.output_cost_per_million_minor):stored.output_cost_per_million_minor??Number(config.output_cost_per_million_minor)} as AgentConfig;
  return {configured:true,state:'CONFIGURED_UNEVALUATED',agent,connection_revision:profile.version};
}
