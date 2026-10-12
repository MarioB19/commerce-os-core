import {withTransaction} from '../../packages/db/src/index.js';
import {ensureProfile} from '../../packages/db/src/profile-provisioning.js';

/** V7 F2: every workspace a historical fixture writes to must be an adopted
 * profile (FKs, quotas). An installation admits at most three profiles, so a
 * test file uses at most three workspaces. Runs as the fixture owner, outside
 * any profile context; it never moves data between profiles. */
export async function fixtureProfiles(...workspaces:string[]){
 for(const workspace of workspaces)await withTransaction(c=>ensureProfile(c,workspace));
}
