import type {FastifyInstance} from 'fastify';
import {profileIdentityRoutes,type ProfileIdentityDependencies} from './profile-identity.js';
import {invitationRegistrationRoutes,type InvitationRegistrationDependencies} from './profile-invitation-registration.js';
import {invitationAcceptanceRoutes,type InvitationAcceptanceDependencies} from './profile-invitation-acceptance.js';
import type {ProfileRequestDependencies} from './profile-request.js';
import {profileOverviewRoutes} from './profile-overview.js';
import {profileSettingsRoutes} from './profile-settings.js';
import {profileEmployeeRoutes} from './profile-employees.js';
import {profileInvitationRoutes} from './profile-invitations.js';
import {profileTokenRoutes} from './profile-tokens.js';
import {profileCatalogRoutes} from './profile-catalog.js';
import {marketVariantRoutes} from './market-variants.js';
import {continuousAuthorizationRoutes} from './continuous-authorization.js';
import {paymentsRegisterRoutes} from './payments-register.js';
import {receiptPolicyRoutes} from './receipt-policies.js';
import {resultsRoutes} from './results.js';
import {resultGoalRoutes} from './result-goals.js';
import {platformProfileRoutes,type PlatformRouteDependencies} from './platform-profiles.js';

export interface ProfileRuntimeDependencies {
 request?:ProfileRequestDependencies;
 identity?:ProfileIdentityDependencies;
 registration?:InvitationRegistrationDependencies;
 acceptance?:InvitationAcceptanceDependencies;
 platform?:PlatformRouteDependencies;
}
/** Fixed composition of the reviewed V2 consumers. Each family retains its own
 * native authorization and transaction; no legacy principal or catch fallback.
 * Register as a Fastify plugin so its privacy headers remain encapsulated.
 */
export async function profileRuntimeRoutes(app:FastifyInstance,deps:ProfileRuntimeDependencies={}){
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');});
 await app.register(async identity=>{
  await profileIdentityRoutes(identity,deps.identity);
  await invitationRegistrationRoutes(identity,deps.registration);
  await invitationAcceptanceRoutes(identity,deps.acceptance);
 });
 await app.register(async platform=>{await platformProfileRoutes(platform,deps.platform);});
 for(const routes of [profileOverviewRoutes,profileSettingsRoutes,profileEmployeeRoutes,
  profileInvitationRoutes,profileTokenRoutes,profileCatalogRoutes,marketVariantRoutes,
  continuousAuthorizationRoutes,paymentsRegisterRoutes,receiptPolicyRoutes,resultsRoutes,resultGoalRoutes]){
  await app.register(async family=>{await routes(family,deps.request);});
 }
}
