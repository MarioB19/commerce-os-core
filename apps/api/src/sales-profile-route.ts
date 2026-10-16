import type {FastifyInstance,RouteHandlerMethod} from 'fastify';
import type {ProfileScope} from '../../../packages/contracts/src/profiles.js';
import {registerProfileSqlRoute} from './profile-sql-route.js';

const reads=Object.freeze({conversation:'conversations:read',contact:'conversations:read',touchpoint:'conversations:read',order:'orders:read',fulfillment:'orders:read',receipt:'receipts:read'} as const);
export type ProfileSalesReadKind=keyof typeof reads;
export function isProfileSalesReadKind(kind:string):kind is ProfileSalesReadKind{return Object.hasOwn(reads,kind);}
export function registerSalesProfileRead(app:FastifyInstance,url:string,kind:ProfileSalesReadKind,handler:RouteHandlerMethod){
 registerProfileSqlRoute(app,{method:'GET',url,action:{scope:reads[kind],mutation:false},permissions:['sales:read'],handler});
}
const actions=Object.freeze({conversation:{scope:'conversations:write',permission:'sales:operate'},review:{scope:'receipts:review',permission:'finance:review'},classification:{scope:'payments:write',permission:'finance:classify'},operations:{scope:'operations:read',permission:'commands:read'}} satisfies Record<string,{scope:ProfileScope;permission:string}>);
export function registerSalesProfileAction(app:FastifyInstance,method:'GET'|'POST',url:string,action:keyof typeof actions,handler:RouteHandlerMethod){
 const fixed=actions[action];
 if((method==='GET')!==(action==='operations'))throw Error('PROFILE_SALES_ACTION_METHOD');
 registerProfileSqlRoute(app,{method,url,action:{scope:fixed.scope,mutation:method==='POST'},permissions:[fixed.permission],handler});
}
