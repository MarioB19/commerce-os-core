import {describe,expect,it} from 'vitest';
import {groupMessageIdentity,sameGroupMessage} from '../../packages/messaging/src/group-message-id.js';
import {effectiveProgramState} from '../../packages/db/src/group-warmup.js';

/** V7.5.3 F3 (docs/adr-v7-5-3-agreement-group-receipts.md). Synthetic IDs
 * with the observed structure; no production identifiers. */
const chat='120363000000000123@g.us',msg='3EB0A1B2C3D4E5F60718';
describe('V7.5.3 F3: canonical identity of a WAHA group message',()=>{
 it('reduces the sender and receiver serializations of the same message to one key',()=>{
  const sent=`true_${chat}_${msg}_5215500000001@c.us`,received=`false_${chat}_${msg}_90000000000001@lid`;
  expect(groupMessageIdentity('waha',sent)).toMatchObject({structured:true,fromMe:true,chat,messageId:msg,participant:'5215500000001@c.us'});
  expect(groupMessageIdentity('waha',received)).toMatchObject({structured:true,fromMe:false,chat,messageId:msg,participant:'90000000000001@lid'});
  expect(groupMessageIdentity('waha',sent)!.key).toBe(groupMessageIdentity('waha',received)!.key);
  expect(sameGroupMessage('waha',sent,received)).toBe('CANONICAL');
  expect(sameGroupMessage('waha',sent,sent)).toBe('LITERAL');
 });
 it('removing only the direction prefix is not enough and is not what is compared',()=>{
  const sent=`true_${chat}_${msg}_5215500000001@c.us`,received=`false_${chat}_${msg}_90000000000001@lid`;
  expect(sent.replace(/^true_/,'')).not.toBe(received.replace(/^false_/,''));
 });
 it('never matches a different message, a different group or a group with a similar number',()=>{
  const sent=`true_${chat}_${msg}_5215500000001@c.us`;
  expect(sameGroupMessage('waha',sent,`false_${chat}_3EB0A1B2C3D4E5F60719_90000000000001@lid`)).toBeNull();
  expect(sameGroupMessage('waha',sent,`false_120363000000000124@g.us_${msg}_90000000000001@lid`)).toBeNull();
  expect(sameGroupMessage('waha',sent,`false_1203630000000001230@g.us_${msg}_90000000000001@lid`)).toBeNull();
 });
 it('keeps unknown or partial structures literal instead of extracting by position',()=>{
  for(const raw of [`true_${chat}_${msg}`,`maybe_${chat}_${msg}_1@c.us`,`true_${chat}_${msg}_x@c.us_extra`,`true_notagroup@c.us_${msg}_5215500000001@c.us`,`true_${chat}_short_5215500000001@c.us`,'wamid.HBgMNTIxNTU1','sim:effect'])
   expect(groupMessageIdentity('waha',raw)).toMatchObject({structured:false});
  expect(sameGroupMessage('waha',`true_${chat}_${msg}`,`false_${chat}_${msg}`)).toBeNull();
  // Other adapters never reduce: their IDs are compared literally.
  const sent=`true_${chat}_${msg}_5215500000001@c.us`,received=`false_${chat}_${msg}_90000000000001@lid`;
  expect(sameGroupMessage('simulator',sent,received)).toBeNull();
  expect(sameGroupMessage('cloud',sent,received)).toBeNull();
  expect(groupMessageIdentity('waha',null)).toBeNull();expect(groupMessageIdentity('waha','x'.repeat(600))).toBeNull();
 });
});
describe('V7.5.3 A05: effective group state with a causal wait',()=>{
 const base={pool:{breaker_open:false},numbers:[{id:'a',connected:true,ownership:'OPERATIONAL'},{id:'b',connected:true,ownership:'OPERATIONAL'}],senderIds:['a','b'],config:{timezone:'America/Mexico_City',startHour:9,endHour:18}};
 const at=new Date('2026-11-13T15:05:09Z');
 it('the production snapshot of 13-nov is «esperando recepción», not «enviando» with an overdue time',()=>{
  const history=[{pending:2,sent:1,delivered:0,uncertain:0,next_send:'2026-11-13T15:03:17Z'}];
  const withHead=effectiveProgramState({...base,status:'ACTIVE',history,now:at,head:{not_before:'2026-11-13T15:03:17Z',status:'BLOCKED',reason:'CAUSAL_PREDECESSOR_UNRESOLVED',predecessor:'SENT'}});
  expect(withHead).toMatchObject({state:'WAITING_RECEIPT',reasons:['PEER_RECEIPT_PENDING'],nextSend:null});
  // Without the head (older reader), the same wait is inferred; never a past time.
  expect(effectiveProgramState({...base,status:'ACTIVE',history,now:at})).toMatchObject({state:'WAITING_RECEIPT',nextSend:null});
 });
 it('a due turn refused by a durable gate is BLOCKED with its reason; transient refusals stay RUNNING without a past time',()=>{
  const history=[{pending:3,sent:1,delivered:1,uncertain:0,next_send:'2026-11-13T15:03:17Z'}];
  expect(effectiveProgramState({...base,status:'ACTIVE',history,now:at,head:{not_before:'2026-11-13T15:03:17Z',status:'BLOCKED',reason:'WARMUP_HEALTH_NOT_READY',predecessor:'DELIVERED'}})).toMatchObject({state:'BLOCKED',reasons:['WARMUP_HEALTH_NOT_READY'],nextSend:null});
  expect(effectiveProgramState({...base,status:'ACTIVE',history,now:at,head:{not_before:'2026-11-13T15:03:17Z',status:'BLOCKED',reason:'WARMUP_CAUSAL_SPACING',predecessor:'DELIVERED'}})).toMatchObject({state:'RUNNING',nextSend:null});
 });
 it('an uncertain predecessor or effect is UNCERTAIN; a future unblocked turn is the next send',()=>{
  expect(effectiveProgramState({...base,status:'ACTIVE',history:[{pending:2,sent:0,delivered:0,uncertain:1,next_send:null}],now:at})).toMatchObject({state:'UNCERTAIN',reasons:['EFFECT_UNCERTAIN']});
  expect(effectiveProgramState({...base,status:'ACTIVE',history:[{pending:2,sent:0,delivered:0,uncertain:0,next_send:'2026-11-13T15:09:00Z'}],now:at,head:{not_before:'2026-11-13T15:09:00Z',status:'READY',reason:null,predecessor:'UNKNOWN'}})).toMatchObject({state:'UNCERTAIN'});
  expect(effectiveProgramState({...base,status:'ACTIVE',history:[{pending:2,sent:1,delivered:1,uncertain:0,next_send:'2026-11-13T15:09:00Z'}],now:at,head:{not_before:'2026-11-13T15:09:00Z',status:'READY',reason:null,predecessor:'DELIVERED'}})).toMatchObject({state:'RUNNING',nextSend:{at:'2026-11-13T15:09:00.000Z',conditional:false}});
  // Outside the window it is «fuera de horario» whatever the queue says.
  expect(effectiveProgramState({...base,status:'ACTIVE',history:[{pending:2,sent:1,delivered:0,uncertain:0,next_send:'2026-11-13T15:03:17Z'}],now:new Date('2026-11-14T02:00:00Z')}).state).toBe('WAITING_WINDOW');
 });
});
