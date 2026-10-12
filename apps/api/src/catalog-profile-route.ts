import type {FastifyInstance,RouteHandlerMethod} from 'fastify';
import type {ProfileScope} from '../../../packages/contracts/src/profiles.js';
import {registerProfileSqlRoute} from './profile-sql-route.js';

const scopes=Object.freeze({category:'products',product:'products',offer:'offers',asset:'materials',workflow:'flows',agent:'sellers'} as const);
export type ProfileCatalogKind=keyof typeof scopes;
export function isProfileCatalogKind(kind:string):kind is ProfileCatalogKind{return Object.hasOwn(scopes,kind);}
/** SQL/materialized route definitions only; kind and mode belong to the server. */
export function registerCatalogProfileRoute(app:FastifyInstance,method:'GET'|'POST'|'PATCH',url:string,kind:ProfileCatalogKind,handler:RouteHandlerMethod,mode:'read'|'write'=method==='GET'?'read':'write'){
 const scope:ProfileScope=`${scopes[kind]}:${mode}`;
 const permission=mode==='read'?'catalog:read':['workflow','agent'].includes(kind)?'workflows:write':'catalog:write';
 registerProfileSqlRoute(app,{method,url,action:{scope,mutation:mode==='write'},permissions:[permission],handler});
}
