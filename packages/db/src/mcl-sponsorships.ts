import type {QueryExecutor} from './index.js';
import type {DomainRecord} from '../../contracts/src/index.js';
/** Compatibility for historical callers. V5 never creates or reactivates sponsorships, including old offer versions. */
export async function syncMclSponsorship(_c:QueryExecutor,_order:DomainRecord){return {retired:true,third_party_effects:0};}
