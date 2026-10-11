/** New-inbound scope is deliberately narrower than permission to message a base.
 * Database creation time and provider time both have to follow the authorization.
 */
export function authorizedRecipient(auth:{scope?:Record<string,any>;created_at:Date|string},contactId:string,conversation:{created_at:Date|string;body:Record<string,any>},now=Date.now()):boolean {
 const scope=auth.scope??{};
 if(['channel_setup','product_assignment'].includes(scope.mode)&&scope.recipient_mode==='new_inbound'){
  const approved=new Date(scope.new_inbound_since??auth.created_at).getTime(),created=new Date(conversation.created_at).getTime(),started=new Date(conversation.body.started_at??0).getTime(),last=new Date(conversation.body.last_inbound_at??0).getTime();
  return Number.isFinite(approved)&&created>=approved&&started>=approved&&started<=now&&last>=started&&last<=now&&now-last<86400000;
 }
 return Array.isArray(scope.contact_ids)?scope.contact_ids.includes(contactId):!['channel_setup','product_assignment'].includes(scope.mode);
}
