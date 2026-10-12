import type {FastifyInstance,FastifyRequest,RouteHandlerMethod} from 'fastify';
import type {ProfileAction} from '../../../packages/domain/src/core/profile-authorization.js';
import {principalMap} from './context.js';
import {profilePrincipalBinder} from './profile-principal-binding.js';
import {authorizedProfileSqlHandler} from './profile-sql-handler.js';
import type {ProfileRequestDependencies} from './profile-request.js';
const key=Symbol('registered-profile-sql-route');
declare module 'fastify' {interface FastifyContextConfig {[key]?:object}}
interface Registration {server:FastifyInstance;url:string;methods:ReadonlySet<string>}
const registrations=new WeakMap<object,Registration>();
/** Only the server's exact registered route can replace the old authentication
 * hook. HTTP headers, fields and config-like payloads carry no authority. */
export function isProfileSqlRequest(request:FastifyRequest):boolean{
 const token=Reflect.get(request.routeOptions.config,key);
 if(!token||typeof token!=='object')return false;
 const registration=registrations.get(token);
 return Boolean(registration&&registration.server===request.server&&registration.url===request.routeOptions.url&&registration.methods.has(request.method));
}
/** Reviewed SQL/materialized handlers only. No late response serializer or
 * streaming options are accepted. Action and aliases are fixed at registration. */
export function registerProfileSqlRoute(app:FastifyInstance,route:{method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE';url:string;action:Omit<ProfileAction,'workspaceId'>;permissions:readonly string[];handler:RouteHandlerMethod},request?:ProfileRequestDependencies){
 if(!route.url.startsWith('/v1/')||/[?*#]/.test(route.url))throw Error('PROFILE_SQL_ROUTE_INVALID');
 const token=Object.freeze({}),registration={server:app,url:route.url,methods:new Set(route.method==='GET'?['GET','HEAD']:[route.method])};
 const handler=authorizedProfileSqlHandler(route.action,route.handler,{request,bindIdentity:profilePrincipalBinder(principalMap,route.permissions)});
 app.route({method:route.method,url:route.url,config:{[key]:token},handler});
 registrations.set(token,registration);
}
