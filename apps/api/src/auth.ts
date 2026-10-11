import {betterAuth} from 'better-auth';
import {hashPassword} from 'better-auth/crypto';
import {Kysely,PostgresDialect} from 'kysely';
import type pg from 'pg';
import {pool,uuid,withTransaction,type QueryExecutor} from '../../../packages/db/src/index.js';
import {identityDigest,resetTTLSeconds} from '../../../packages/db/src/identity.js';
import type {Role} from '../../../packages/contracts/src/index.js';
import {enqueueResetMail} from './identity-mail.js';
export const trustedOrigins=(process.env.TRUSTED_ORIGINS??process.env.CLIENT_ORIGIN??'http://localhost:5173,http://localhost:3001').split(',').map(x=>x.trim());
/** A scoped instance uses the caller's transaction. The adapter must never BEGIN/COMMIT it. */
export function createAuth(client?:pg.PoolClient){
 const database=client?{db:new Kysely<any>({dialect:new PostgresDialect({pool:{options:{},connect:async()=>({query:client.query.bind(client),release:()=>{}}),end:async()=>{}}})}),type:'postgres' as const,transaction:false}:pool;
 return betterAuth({database,secret:process.env.BETTER_AUTH_SECRET,baseURL:process.env.BETTER_AUTH_URL??'http://localhost:3001',trustedOrigins,
  logger:{disabled:true},
  emailAndPassword:{enabled:true,disableSignUp:true,minPasswordLength:12,maxPasswordLength:128,resetPasswordTokenExpiresIn:resetTTLSeconds,revokeSessionsOnPasswordReset:true,
   sendResetPassword:async({user,token})=>{if(!client)throw new Error('IDENTITY_TRANSACTION_REQUIRED');await enqueueResetMail(client,user,token);}},
  verification:{storeIdentifier:{default:'plain',overrides:{'reset-password:':{hash:async identifier=>identityDigest('reset',identifier)}}}},
  advanced:{useSecureCookies:process.env.NODE_ENV==='production'},
  session:{expiresIn:60*60*12,updateAge:60*60,cookieCache:{enabled:false}},
  // HTTP boundary implements persistent limits, including direct native routes.
  rateLimit:{enabled:false}
 });
}
export const auth=createAuth();
export async function provisionUser(input:{email:string;password:string;name:string;workspace_id:string;role:Role},client?:QueryExecutor){const executor=client??pool;const existing=(await executor.query('SELECT id FROM "user" WHERE email=$1',[input.email.toLowerCase()])).rows[0];if(existing)throw Object.assign(new Error('USER_EXISTS'),{statusCode:409});const password=await hashPassword(input.password),userId=uuid();const write=async(c:QueryExecutor)=>{await c.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[userId,input.name,input.email.toLowerCase()]);await c.query('INSERT INTO account(id,"accountId","providerId","userId",password,issuer) VALUES($1,$2,$3,$2,$4,$5)',[uuid(),userId,'credential',password,'local:credential']);await c.query('INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,$3)',[userId,input.workspace_id,input.role]);};if(client)await write(client);else await withTransaction(write);return{id:userId,name:input.name,email:input.email,role:input.role};}
