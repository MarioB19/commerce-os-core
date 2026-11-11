import {describe,it,expect,vi} from 'vitest';
import {WahaProvider} from '../../packages/messaging/src/providers.js';
import {parseGroup,parseGroupList} from '../../packages/messaging/src/groups.js';
import {groupEligibility} from '../../packages/db/src/warmup-groups.js';
import {groupReadReason} from '../../apps/channel-worker/src/number-operations.js';

/** V7.4 B. Synthetic fixtures with the exact structure WAHA 2026.8.2 / GOWS
 * answers (observed read-only on the installed gateways, values invented):
 * list and detail rows carry `JID`/`Name`, participants v2 carry `id` (LID),
 * `pn` (phone) and `role`, and the send permission is `adminsOnly`. */
const GROUP='120363000000000001@g.us';
const gowsRow=(jid=GROUP,name='Grupo sintético')=>({JID:jid,OwnerJID:'90000000000001@lid',OwnerPN:'5215500000001@s.whatsapp.net',Name:name,NameSetAt:'2026-11-01T00:00:00Z',NameSetBy:'90000000000001@lid',NameSetByPN:'5215500000001@s.whatsapp.net',Topic:'',TopicID:'',TopicSetAt:'2026-11-01T00:00:00Z',TopicSetBy:'',TopicSetByPN:'',TopicDeleted:false,IsLocked:false,IsAnnounce:false,AnnounceVersionID:'1',IsEphemeral:false,DisappearingTimer:0,IsIncognito:false,IsParent:false,DefaultMembershipApprovalMode:'',LinkedParentJID:'',IsDefaultSubGroup:false,IsJoinApprovalRequired:false,AddressingMode:'lid',GroupCreated:'2026-11-01T00:00:00Z',CreatorCountryCode:'52',ParticipantVersionID:'1',
 Participants:[{JID:'90000000000001@lid',PhoneNumber:'5215500000001@s.whatsapp.net',LID:'90000000000001@lid',IsAdmin:true,IsSuperAdmin:true,DisplayName:'',Error:0,AddRequest:null}],ParticipantCount:5,MemberAddMode:'admin_add',Suspended:false});
const gowsParticipants=[
 {id:'90000000000001@lid',pn:'5215500000001@c.us',role:'superadmin'},
 {id:'90000000000002@lid',pn:'5215500000002@c.us',role:'participant'},
 {id:'90000000000003@lid',pn:'5215500000003@c.us',role:'participant'},
 {id:'90000000000004@lid',pn:'5215500000004@c.us',role:'participant'},
 {id:'90000000000005@lid',pn:'5215500000005@c.us',role:'participant'}];
const runtime={version:'2026.8.2',engine:'GOWS'};
function gateway(overrides:Record<string,(url:URL)=>unknown|Response>={}){
 const calls:string[]=[];
 const fetcher=vi.fn(async(input:string|URL|Request)=>{const url=new URL(String(input)),path=url.pathname;calls.push(path+url.search);
  for(const [suffix,answer] of Object.entries(overrides))if(path.endsWith(suffix)){const value=answer(url);return value instanceof Response?value:new Response(JSON.stringify(value));}
  if(path==='/api/server/version')return new Response(JSON.stringify(runtime));
  if(path.endsWith('/participants/v2'))return new Response(JSON.stringify(gowsParticipants));
  if(path.endsWith('/settings/security/messages-admin-only'))return new Response(JSON.stringify({adminsOnly:false}));
  if(path.endsWith('/groups'))return new Response(JSON.stringify([gowsRow()]));
  return new Response(JSON.stringify(gowsRow()));});
 return{provider:new WahaProvider({baseUrl:'http://waha-test:3000',apiKey:'fixture',session:'default',engine:'GOWS'},fetcher),calls};
}

describe('V7.4 — WAHA GOWS group contract',()=>{
 it('lists groups answered as JID/Name and keeps the formats admitted before',async()=>{
  const {provider,calls}=gateway();
  expect(await provider.listGroups({offset:0,limit:20})).toEqual({groups:[{id:GROUP,name:'Grupo sintético'}],hasMore:false});
  expect(calls[0]).toBe('/api/default/groups?offset=0&limit=20');
  // Earlier engines: id + subject|name, as an array or as an object keyed by id.
  expect(parseGroupList([{id:'1@g.us',subject:'A'},{id:{_serialized:'2-3@g.us'},name:'B'}],20)).toEqual([{id:'1@g.us',name:'A'},{id:'2-3@g.us',name:'B'}]);
  expect(parseGroupList({'1@g.us':{id:'1@g.us',subject:'A'}},20)).toEqual([{id:'1@g.us',name:'A'}]);
  expect(parseGroupList([],20)).toEqual([]);
 });
 it('pages with offset and limit and bounds what one answer may contain',async()=>{
  const {provider}=gateway({'/groups':url=>Array.from({length:Number(url.searchParams.get('limit'))},(_,i)=>gowsRow(`12036300000000${String(i+Number(url.searchParams.get('offset'))).padStart(4,'0')}@g.us`))});
  const page=await provider.listGroups({offset:20,limit:20});expect(page.groups).toHaveLength(20);expect(page.hasMore).toBe(true);expect(page.groups[0]!.id).toBe('120363000000000020@g.us');
  await expect(provider.listGroups({offset:-1,limit:20})).rejects.toThrow('GROUP_PAGINATION_INVALID');
  await expect(provider.listGroups({offset:0,limit:101})).rejects.toThrow('GROUP_PAGINATION_INVALID');
  await expect(gateway({'/groups':()=>Array.from({length:21},(_,i)=>gowsRow(`${i+1}@g.us`))}).provider.listGroups({offset:0,limit:20})).rejects.toThrow('GROUP_LIST_RESPONSE_UNSUPPORTED');
 });
 it('rejects malformed, duplicated or contradictory list answers instead of guessing',()=>{
  for(const value of [null,'text',7,[null],[{}],[{JID:'not-a-group'}],[{JID:5}],[{id:'1@g.us',JID:'2@g.us'}],[gowsRow(),gowsRow()],[[gowsRow()]]])
   expect(()=>parseGroupList(value,20),JSON.stringify(value)?.slice(0,60)).toThrow('GROUP_LIST_RESPONSE_UNSUPPORTED');
 });
 it('reads detail, participants and send permission of a GOWS group; LID resolves only through pn',async()=>{
  const {provider}=gateway(),group=await provider.group(GROUP);
  expect(group).toMatchObject({id:GROUP,name:'Grupo sintético',adminOnly:false,complete:true,runtime});
  expect(group.members).toHaveLength(5);
  expect(group.members[0]).toEqual({identity:'lid:90000000000001',verifiedIdentity:'wa:5215500000001',admin:true,mappingSource:'provider_explicit_mapping'});
  expect(group.members.slice(1).every(m=>!m.admin&&m.identity.startsWith('lid:')&&m.verifiedIdentity?.startsWith('wa:52155'))).toBe(true);
  // adminsOnly=true is carried, never read as «everyone may write».
  expect((await gateway({'/settings/security/messages-admin-only':()=>({adminsOnly:true})}).provider.group(GROUP)).adminOnly).toBe(true);
 });
 it('keeps a member without an explicit phone mapping as an opaque external identity',()=>{
  const g=parseGroup(GROUP,gowsRow(),[...gowsParticipants.slice(0,3),{id:'90000000000009@lid',role:'participant'},{id:'90000000000010@lid',pn:null,role:'participant'}],{adminsOnly:false},runtime);
  expect(g.members.slice(3)).toEqual([{identity:'lid:90000000000009',verifiedIdentity:null,admin:false,mappingSource:'unresolved'},{identity:'lid:90000000000010',verifiedIdentity:null,admin:false,mappingSource:'unresolved'}]);
  // Equal digits in a LID and a phone are never a mapping.
  const twin=parseGroup(GROUP,gowsRow(),[{id:'5215500000001@lid',role:'participant'},{id:'5215500000001@c.us',role:'participant'}],{adminsOnly:false},runtime);
  expect(twin.members.map(m=>m.verifiedIdentity)).toEqual([null,'wa:5215500000001']);
 });
 it('rejects unknown permissions, contradictory identities and answers for another group',()=>{
  const read=(participants:unknown,security:Record<string,unknown>={adminsOnly:false},detail:Record<string,unknown>=gowsRow())=>()=>parseGroup(GROUP,detail,participants,security,runtime);
  expect(read(gowsParticipants,{})).toThrow('GROUP_PERMISSION_RESPONSE_UNSUPPORTED');
  expect(read(gowsParticipants,{adminsOnly:'no'})).toThrow('GROUP_PERMISSION_RESPONSE_UNSUPPORTED');
  expect(read(gowsParticipants,{adminsOnly:true,adminOnly:false})).toThrow('GROUP_PERMISSION_RESPONSE_UNSUPPORTED');
  expect(read(gowsParticipants,{adminOnly:false,adminsOnly:false})).not.toThrow();
  expect(read(gowsParticipants,{adminsOnly:false},gowsRow('120363000000000002@g.us'))).toThrow('GROUP_RESPONSE_MISMATCH');
  expect(read([{id:'90000000000001@lid',pn:'5215500000001@c.us',phoneNumber:'5215500000002@c.us',role:'participant'}])).toThrow('GROUP_MEMBER_IDENTITY_CONFLICT');
  expect(read([{id:'5215500000001@c.us',pn:'5215500000002@c.us',role:'participant'}])).toThrow('GROUP_MEMBER_IDENTITY_CONFLICT');
  expect(read([gowsParticipants[0],{id:'90000000000002@lid',pn:'5215500000001@c.us',role:'participant'}])).toThrow('GROUP_MEMBER_IDENTITY_CONFLICT');
  expect(read([gowsParticipants[0],gowsParticipants[0]])).toThrow('GROUP_DUPLICATE_MEMBERS');
  expect(read([{id:'90000000000001@lid',pn:5,role:'participant'}])).toThrow('GROUP_MEMBER_UNRESOLVED');
  expect(read([{id:'90000000000001@lid',role:'owner'}])).toThrow('GROUP_MEMBER_UNRESOLVED');
  expect(read([{id:'something-else',role:'participant'}])).toThrow('GROUP_MEMBER_UNRESOLVED');
  expect(read([])).toThrow('GROUP_RESPONSE_INCOMPLETE');expect(read({})).toThrow('GROUP_RESPONSE_INCOMPLETE');
  expect(read(Array.from({length:1025},(_,i)=>({id:`${i+1}00000@lid`,role:'participant'})))).toThrow('GROUP_RESPONSE_INCOMPLETE');
 });
 it('names transport, session and format failures differently; none of them says «scan the QR»',async()=>{
  const failing=(status:number)=>gateway({'/groups':()=>new Response('{}',{status})}).provider.listGroups({offset:0,limit:20}).then(()=>'OK',groupReadReason);
  expect(await failing(401)).toBe('GROUP_PROVIDER_REJECTED');expect(await failing(404)).toBe('GROUP_SESSION_NOT_READY');expect(await failing(422)).toBe('GROUP_SESSION_NOT_READY');
  expect(await failing(500)).toBe('GROUP_PROVIDER_UNAVAILABLE');expect(await failing(503)).toBe('GROUP_PROVIDER_UNAVAILABLE');
  expect(groupReadReason(new DOMException('fixture timeout','TimeoutError'))).toBe('GROUP_PROVIDER_UNAVAILABLE');expect(groupReadReason(new TypeError('fetch failed'))).toBe('GROUP_PROVIDER_UNAVAILABLE');
  expect(await gateway({'/groups':()=>[{id:'x'}]}).provider.listGroups({offset:0,limit:20}).then(()=>'OK',groupReadReason)).toBe('GROUP_LIST_RESPONSE_UNSUPPORTED');
  expect(groupReadReason(new Error('GROUP_OWN_LINE_UNRESOLVED'))).toBe('GROUP_OWN_LINE_UNRESOLVED');expect(groupReadReason(new Error('private detail 5215500000001'))).toBe('GROUP_PROVIDER_UNAVAILABLE');
  await expect(gateway({'/api/server/version':()=>({version:'2026.8.2',engine:'NOWEB'})}).provider.group(GROUP)).rejects.toThrow('PROVIDER_RUNTIME_UNVERIFIED');
 });
});

describe('V7.4 — who may take part in a group with external members',()=>{
 const now=new Date('2026-11-11T12:00:00Z'),at=new Date(+now-1000).toISOString();
 const member=(account_id:string|null,admin=false)=>({account_id,identity_hash:'h'+(account_id??Math.random()),verified_hash:account_id?'v'+account_id:null,admin,mapping_source:'provider_explicit_mapping'});
 const mixed={members:[member('a'),member('b'),member('c'),member(null),member(null)],permissions:{admin_only:false},observed_at:at,expires_at:new Date(+now+59000),
  capabilities:{protocol:'v1',all_members_resolved:false,own_members:3,external_members:2,observations:{a:{observed_at:at},b:{observed_at:at},c:{observed_at:at}}}};
 it('admits three own senders plus two externals only for the audience-aware mode',()=>{
  expect(groupEligibility(mixed,['a','b','c'],now,['a','b','c'],{audience:true})).toBeNull();
  // Own lines that only receive are audience too: two take part, one does not.
  expect(groupEligibility(mixed,['a','b'],now,['a','b'],{audience:true})).toBeNull();
  // The earlier authorized mode keeps its strict rule.
  expect(groupEligibility(mixed,['a','b','c'],now)).toBe('GROUP_MEMBER_UNRESOLVED');
 });
 it('never lets an external or a line outside the group take part or send',()=>{
  expect(groupEligibility(mixed,['a','b','z'],now,['a','b'],{audience:true})).toBe('GROUP_PARTICIPANT_NOT_IN_GROUP');
  expect(groupEligibility(mixed,['a','b'],now,['a','c'],{audience:true})).toBe('GROUP_PARTICIPANT_NOT_IN_GROUP');
  expect(groupEligibility(mixed,[],now,[],{audience:true})).toBe('GROUP_PARTICIPANT_NOT_IN_GROUP');
  expect(groupEligibility({...mixed,members:[member('a'),member('a'),member(null)]},['a'],now,['a'],{audience:true})).toBe('GROUP_MEMBER_UNRESOLVED');
 });
 it('still requires write permission, a fresh read and each participating line to have seen the group',()=>{
  expect(groupEligibility({...mixed,permissions:{admin_only:true}},['a','b','c'],now,['a','b'],{audience:true})).toBe('GROUP_SEND_PERMISSION_REQUIRED');
  expect(groupEligibility({...mixed,permissions:{admin_only:true},members:[member('a',true),member('b',true),member('c'),member(null)]},['a','b','c'],now,['a','b'],{audience:true})).toBeNull();
  expect(groupEligibility({...mixed,expires_at:new Date(+now-1)},['a','b','c'],now,['a','b','c'],{audience:true})).toBe('GROUP_MEMBERSHIP_STALE');
  expect(groupEligibility({...mixed,capabilities:{...mixed.capabilities,observations:{a:{observed_at:at},b:{observed_at:at}}}},['a','b','c'],now,['a','b','c'],{audience:true})).toBe('GROUP_SHARED_IDENTITY_UNVERIFIED');
  expect(groupEligibility({...mixed,retired_at:now},['a','b','c'],now,['a','b','c'],{audience:true})).toBe('GROUP_RETIRED');
 });
});
