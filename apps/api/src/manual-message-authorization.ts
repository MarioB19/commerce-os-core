import type {FastifyRequest} from 'fastify';
import type {QueryExecutor} from '../../../packages/db/src/index.js';
import type {DomainRecord} from '../../../packages/contracts/src/index.js';
import {assignmentFor,assignmentGate,channelIdentityHash} from '../../../packages/db/src/commercial-assignments.js';
import {authorizedRecipient} from '../../../packages/domain/src/sales/authorization.js';
import {scopedRecord,fail} from './context.js';

/** Pick the current authorization of this journey; dispatch still performs its full gate. */
export async function manualMessageAuthorization(req:FastifyRequest,c:QueryExecutor,conversation:DomainRecord){
 const account=await scopedRecord(req,'channel_account',conversation.body.account_id,c);
 const assignment=conversation.body.assignment_id?await assignmentFor(c,conversation.workspace_id,conversation.environment,conversation.body.assignment_id,'share'):undefined;
 if(conversation.body.assignment_id&&(!assignment||assignment.account_id!==account.id||assignment.product_id!==conversation.body.product_id||await assignmentGate(c,conversation)))throw fail(409,'ASSIGNMENT_CHANGED','Revisa el producto y la autorización de esta conversación.');
 const candidate=assignment?assignment.authorization_id:account.body.active_authorization_id;
 const auth=candidate?(await c.query('SELECT * FROM operation_authorizations WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND revoked_at IS NULL AND expires_at>now()',[candidate,conversation.workspace_id,conversation.environment])).rows[0]:undefined;
 const scope=auth?.scope??{};
 if(!auth||!authorizedRecipient(auth,conversation.body.contact_id,conversation))throw fail(409,'OPERATION_AUTHORIZATION_REQUIRED','Autoriza este contacto para el producto de la conversación.');
 if(assignment&&(scope.mode!=='product_assignment'||scope.assignment_id!==assignment.id||scope.assignment_revision!==assignment.revision||scope.binding_id!==assignment.binding_id||scope.product_id!==conversation.body.product_id||scope.channel_identity_hash!==channelIdentityHash(account)))throw fail(409,'OPERATION_AUTHORIZATION_REQUIRED');
 return auth.id as string;
}
