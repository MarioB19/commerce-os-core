import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {personalContinuity} from '../../../packages/commerce-client/src/continuous-authorization.js';
import {personalPayments} from '../../../packages/commerce-client/src/payments.js';
import {personalProfileCatalog} from '../../../packages/commerce-client/src/profile-catalog.js';
import {personalReceiptPolicies} from '../../../packages/commerce-client/src/receipt-policies.js';
import {personalResults} from '../../../packages/commerce-client/src/results.js';
import {personalProfileV1,personalProfileV2,personalVariantClient} from '../../../packages/commerce-client/src/profile-v2.js';
import {personalProfileSales} from '../../../packages/commerce-client/src/profile-sales.js';
import {registerProfileRegistryTools} from './registry-tools.js';

/** V7 composed MCP server (RF-15): every tool is bound to the one profile and
 * scopes of the configured personal access token (cos_pat_). No tool accepts a
 * profile, token or origin as input; the API re-authorizes every call. */
export function createProfileMcp(origin:string,token:string,fetcher:typeof fetch=fetch){
 if(!/^https?:\/\//.test(origin))throw Error('MCP_CONFIGURATION_REQUIRED');
 if(!/^cos_pat_[A-Za-z0-9_-]{20,}$/.test(token))throw Error('MCP_PROFILE_TOKEN_REQUIRED');
 const server=new McpServer({name:'commerce-os',version:'7.0.0'},{capabilities:{tools:{}}});
 registerProfileRegistryTools(server,{v2:personalProfileV2(origin,token,fetcher),v1:personalProfileV1(origin,token,fetcher),catalog:personalProfileCatalog(origin,token,fetcher),variant:personalVariantClient(origin,token,fetcher),
  continuity:personalContinuity(origin,token,fetcher),payments:personalPayments(origin,token,fetcher),receiptPolicies:personalReceiptPolicies(origin,token,fetcher),results:personalResults(origin,token,fetcher),sales:personalProfileSales(origin,token,fetcher)});
 return server;
}
