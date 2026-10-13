import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {personalContinuity} from '../../../packages/commerce-client/src/continuous-authorization.js';
import {personalMarketVariants} from '../../../packages/commerce-client/src/market-variants.js';
import {personalPayments} from '../../../packages/commerce-client/src/payments.js';
import {personalProfileCatalog} from '../../../packages/commerce-client/src/profile-catalog.js';
import {personalReceiptPolicies} from '../../../packages/commerce-client/src/receipt-policies.js';
import {personalResults} from '../../../packages/commerce-client/src/results.js';
import {registerContinuityTools} from './continuous-authorization.js';
import {registerMarketVariantsTools} from './market-variants.js';
import {registerPaymentsTools} from './payments.js';
import {registerProfileCatalogTools} from './profile-catalog.js';
import {registerReceiptPolicyTools} from './receipt-policies.js';
import {registerResultsTools} from './results.js';

/** V7 composed MCP server (RF-15): every tool is bound to the one profile and
 * scopes of the configured personal access token (cos_pat_). No tool accepts a
 * profile, token or origin as input; the API re-authorizes every call. */
export function createProfileMcp(origin:string,token:string,fetcher:typeof fetch=fetch){
 if(!/^https?:\/\//.test(origin))throw Error('MCP_CONFIGURATION_REQUIRED');
 if(!/^cos_pat_[A-Za-z0-9_-]{20,}$/.test(token))throw Error('MCP_PROFILE_TOKEN_REQUIRED');
 const server=new McpServer({name:'commerce-os',version:'7.0.0'},{capabilities:{tools:{}}});
 registerProfileCatalogTools(server,personalProfileCatalog(origin,token,fetcher));
 registerMarketVariantsTools(server,personalMarketVariants(origin,token,fetcher));
 registerContinuityTools(server,personalContinuity(origin,token,fetcher));
 registerPaymentsTools(server,personalPayments(origin,token,fetcher));
 registerReceiptPolicyTools(server,personalReceiptPolicies(origin,token,fetcher));
 registerResultsTools(server,personalResults(origin,token,fetcher));
 return server;
}
