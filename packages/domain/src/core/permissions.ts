import {rolePermissions,type Role,type Body} from '../../../contracts/src/index.js';
export interface Principal{authentication_method?:"session"|"service_token"|"personal_access_token";token_expires_at?:string;user:{id:string;name:string;email:string};workspace_id:string;role:Role;permissions:string[];service:boolean;scopes:string[];token_id?:string;idempotency_actor?:string;allowed_environments?:string[];resource_ids?:string[]|null}
export function permits(p:Principal,permission:string){return p.service?p.scopes.includes(permission):p.permissions.includes('*')||p.permissions.includes(permission)||p.permissions.includes('read')&&permission.endsWith(':read');}
export function assertPermission(p:Principal,permission:string){if(!permits(p,permission))throw Object.assign(new Error('No tienes permiso para esta operación.'),{code:'FORBIDDEN',statusCode:403});}
export function permissionsFor(role:Role){return rolePermissions[role];}
export function isAssigned(p:Principal,body:Body){return p.role!=='seller'||body.assigned_to===p.user.id;}
