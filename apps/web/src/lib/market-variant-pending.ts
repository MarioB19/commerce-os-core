import {z} from 'zod';
import {marketCommandSchema,type MarketCommand} from '../../../../packages/contracts/src/market-variant-client.js';
import {profileIdSchema} from '../../../../packages/contracts/src/profiles.js';
import {marketEnvironmentSchema} from '../../../../packages/contracts/src/market-variant-store.js';
type Mutation=Extract<MarketCommand,{operation_id:string}>;
export interface MarketPendingStore{load():Mutation|null;save(command:Mutation):void;clear():void}
const scopeSchema=z.object({workspace:profileIdSchema,actor:profileIdSchema,environment:marketEnvironmentSchema,family:z.uuid()}).strict();
/** Local recovery state is never server authority. It contains reviewed public
 * references only; no token, private instructions, bank body or key. */
export function marketVariantPending(scope:unknown,storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>):MarketPendingStore{
 const expected=scopeSchema.parse(scope),key='commerce:market-pending:v1:'+JSON.stringify(expected);
 const schema=z.object({version:z.literal(1),scope:scopeSchema,command:marketCommandSchema}).strict();
 function validate(raw:unknown):Mutation{
  const value=schema.parse(raw),q=value.command;
  if(JSON.stringify(value.scope)!==JSON.stringify(expected)||q.environment!==expected.environment||!('operation_id'in q)||
   q.operation==='adopt'&&q.body.product_id!==expected.family||q.operation==='create'&&q.body.family_id!==expected.family)throw Error('MARKET_PENDING_SCOPE_CHANGED');
  return q;
 }
 return{load(){const raw=storage.getItem(key);if(raw===null)return null;if(raw.length>65536)throw Error('MARKET_PENDING_INVALID');return validate(JSON.parse(raw));},
 save(command){const value={version:1,scope:expected,command};validate(value);const raw=JSON.stringify(value);if(raw.length>65536)throw Error('MARKET_PENDING_INVALID');storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw Error('MARKET_PENDING_UNCONFIRMED');},
 clear(){storage.removeItem(key);if(storage.getItem(key)!==null)throw Error('MARKET_PENDING_UNCONFIRMED');}};
}
