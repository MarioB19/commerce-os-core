import {randomInt} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fromNodeHeaders} from 'better-auth/node';
import {verifyPassword} from 'better-auth/crypto';
import {z} from 'zod';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {pool,withTransaction} from '../../../packages/db/src/index.js';
import {identityAudit,identityDigest,identityLimit,identityLock,activeMember,invalidateResetLinks} from '../../../packages/db/src/identity.js';
import {auth,createAuth,trustedOrigins} from './auth.js';
import {fail} from './context.js';
import {mailReady,publicWebOrigin} from './identity-mail.js';

export const recoveryMessage='Si existe una cuenta activa con ese correo, recibirás instrucciones para recuperar el acceso.';
const password=z.string().min(12).max(128);
const newPasswordFields={newPassword:password,confirmPassword:z.string().max(128)};
const changeSchema=z.object({...newPasswordFields,currentPassword:z.string().min(1).max(128),revokeOtherSessions:z.boolean().optional()}).strict();
const resetSchema=z.object({...newPasswordFields,token:z.string().min(1).max(256)}).strict();
const requestSchema=z.object({email:z.string().trim().toLowerCase().max(254).pipe(z.email()),redirectTo:z.string().max(512).optional()}).strict();
const signInSchema=z.object({email:z.string().trim().toLowerCase().max(254).pipe(z.email()),password:z.string().min(1).max(128),rememberMe:z.boolean().optional(),callbackURL:z.string().optional()}).strict();
const routes=new Map([['/sign-in/email','POST'],['/sign-out','POST'],['/get-session','GET'],['/change-password','POST'],['/request-password-reset','POST'],['/reset-password','POST']]);
const messages:Record<string,string>={INVALID_PASSWORD:'La contraseña actual es incorrecta.',INVALID_EMAIL_OR_PASSWORD:'Correo o contraseña incorrectos.',INVALID_TOKEN:'El enlace venció o ya fue utilizado. Solicita otro.',SESSION_EXPIRED:'Tu sesión venció. Vuelve a iniciar sesión.',UNAUTHORIZED:'Vuelve a iniciar sesión.',FRESH_SESSION_REQUIRED:'Vuelve a iniciar sesión para cambiar tu contraseña.'};
function safeBody(value:any):any{if(Array.isArray(value))return value.map(safeBody);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['token','password','accessToken','refreshToken','idToken'].includes(key)).map(([k,v])=>[k,safeBody(v)]));return value;}
async function deliver(response:Response,reply:FastifyReply){
 const body=await response.json().catch(()=>null) as any;
 reply.code(response.status);
 const cookies=response.headers.getSetCookie();if(response.ok&&cookies.length)reply.header('set-cookie',cookies);
 if(!response.ok){const code=String(body?.code??'AUTH_FAILED');return reply.send({error:{code:messages[code]?code:'AUTH_FAILED',message:messages[code]??'No se pudo completar. Vuelve a iniciar sesión o solicita otro enlace.'}});}
 return reply.send(safeBody(body));
}
class AuthResponseError extends Error {constructor(readonly response:Response){super('AUTH_RESPONSE_REJECTED');}}
async function limit(kind:string,key:string,max:number,reply:FastifyReply,seconds=900){if(!await identityLimit(kind,key,max,seconds)){reply.header('Retry-After',String(seconds));throw fail(429,'RATE_LIMITED','Hay demasiados intentos. Espera antes de volver a intentar.');}}
function checkConfirmation(body:{newPassword:string;confirmPassword:string;currentPassword?:string}){
 if(body.newPassword!==body.confirmPassword)throw fail(400,'CONFIRMATION_MISMATCH','La confirmación no coincide.',[{path:'confirmPassword',message:'La confirmación no coincide.'}]);
 if(body.currentPassword===body.newPassword)throw fail(400,'PASSWORD_UNCHANGED','Elige una contraseña diferente.',[{path:'newPassword',message:'Elige una contraseña diferente.'}]);
}
export async function accountAuthHandler(req:FastifyRequest,reply:FastifyReply){
 reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer');
 const url=new URL(req.url,'http://internal'),path=url.pathname.slice('/api/auth'.length),started=Date.now();
 let auditUser:string|undefined;
 const operation=path==='/request-password-reset'?'password.reset_requested':path==='/reset-password'?'password.reset':path==='/change-password'?'password.change':'session.access';
 try{
  if(req.headers.authorization)throw fail(403,'HUMAN_SESSION_REQUIRED','Esta operación requiere una cuenta humana.');
  if(req.method==='POST'&&(!req.headers.origin||!trustedOrigins.includes(req.headers.origin)))throw fail(403,'ORIGIN_REJECTED','Origen no permitido.');
  if(req.method==='GET'&&/^\/reset-password\/[^/]+$/.test(path)){
   await limit('reset-visit-ip',req.ip,60,reply,60);
   const callback=url.searchParams.get('callbackURL');
   if(callback&&callback!==publicWebOrigin()+'/reset-password')throw fail(400,'REDIRECT_REJECTED','Destino no permitido.');
   const token=decodeURIComponent(path.slice('/reset-password/'.length));
   const digest=identityDigest('reset','reset-password:'+token);
   const valid=(await pool.query('SELECT 1 FROM identity_reset_links l JOIN verification v ON v.identifier=l.digest WHERE l.digest=$1 AND l.expires_at>now() AND v."expiresAt">now()',[digest])).rowCount;
   return reply.redirect(publicWebOrigin()+'/reset-password'+(valid?'#token='+encodeURIComponent(token):'?error=INVALID_TOKEN'));
  }
  if(routes.get(path)!==req.method)throw fail(path.includes('sign-up')?403:404,'AUTH_ROUTE_DISABLED','Ruta no disponible.');
  if(url.search)throw fail(400,'QUERY_NOT_ALLOWED','Envía los datos en el formulario.');
  if(req.method==='POST')await limit('auth-ip:'+path,req.ip,path==='/request-password-reset'?10:path==='/sign-in/email'?30:10,reply,path==='/sign-in/email'?60:900);
  let body:any=req.body??{};
  if(path==='/change-password'){body=changeSchema.parse(body);checkConfirmation(body);body={currentPassword:body.currentPassword,newPassword:body.newPassword,revokeOtherSessions:true};}
  if(path==='/reset-password'){body=resetSchema.parse(body);checkConfirmation(body);body={newPassword:body.newPassword,token:body.token};}
  if(path==='/sign-in/email'){body=signInSchema.parse(body);body.email=body.email.trim().toLowerCase();if(body.callbackURL&&body.callbackURL!==publicWebOrigin()+'/home')throw fail(400,'REDIRECT_REJECTED');}
  if(path==='/request-password-reset'){
   body=requestSchema.parse(body);body.email=body.email.trim().toLowerCase();
   if(body.redirectTo&&body.redirectTo!==publicWebOrigin()+'/reset-password')throw fail(400,'REDIRECT_REJECTED','Destino no permitido.');
   body.redirectTo=publicWebOrigin()+'/reset-password';
   if(!await mailReady())throw fail(503,'RECOVERY_UNAVAILABLE','La recuperación por correo no está disponible temporalmente. Contacta a tu administrador.');
   if(!await identityLimit('reset-recipient',body.email,3)){
    await identityAudit(pool,operation,'SUPPRESSED',req.id);return reply.send({status:true,message:recoveryMessage});
   }
  }
  // Resolve the signed cookie before borrowing a transaction connection. Never exhaust the pool with nested reads.
  const sessionUser=['/change-password','/get-session','/sign-out'].includes(path)?(await auth.api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}}))?.user.id:undefined;
  if(path==='/change-password'){if(!sessionUser)throw fail(401,'SESSION_EXPIRED',messages.SESSION_EXPIRED);await limit('change-user',sessionUser,10,reply);}
  const response=await withTransaction(async c=>{
   const scoped=createAuth(c);
   let user:string|undefined;
   if(path==='/sign-in/email'||path==='/request-password-reset')user=(await c.query('SELECT id FROM "user" WHERE lower(email)=$1',[body.email])).rows[0]?.id;
   else if(path==='/reset-password')user=(await c.query('SELECT user_id FROM identity_reset_links WHERE digest=$1',[identityDigest('reset','reset-password:'+body.token)])).rows[0]?.user_id;
   else user=sessionUser;
   auditUser=user;
   if(user)await identityLock(c,user);
   const member=user?await activeMember(c,user):undefined;
   if(path==='/request-password-reset'&&!member){await identityAudit(c,operation,'ACCEPTED',req.id,user);return Response.json({status:true,message:recoveryMessage});}
   if(path==='/sign-in/email'&&user&&!member){
    // Match the ordinary wrong-password hash work without disclosing membership.
    const account=(await c.query('SELECT password FROM account WHERE "userId"=$1 AND "providerId"=\'credential\'',[user])).rows[0];
    if(account?.password)await verifyPassword({hash:account.password,password:body.password});
    throw fail(401,'INVALID_EMAIL_OR_PASSWORD',messages.INVALID_EMAIL_OR_PASSWORD);
   }
   if(path==='/reset-password'){
    if(!user||!member)throw fail(400,'INVALID_TOKEN',messages.INVALID_TOKEN);
    const digest=identityDigest('reset','reset-password:'+body.token);
    if(!(await c.query('SELECT 1 FROM identity_reset_links l JOIN verification v ON v.identifier=l.digest WHERE l.digest=$1 AND l.expires_at>now() AND v."expiresAt">now()',[digest])).rowCount)throw fail(400,'INVALID_TOKEN',messages.INVALID_TOKEN);
   }
   if(path==='/change-password'||path==='/get-session'){
    const current=await scoped.api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});
    if(!current)throw fail(401,'SESSION_EXPIRED',messages.SESSION_EXPIRED);
    if(!member)throw fail(403,'NO_MEMBERSHIP','Tu acceso al equipo está desactivado.');
   }
   const response=await scoped.handler(new Request((process.env.BETTER_AUTH_URL??'http://localhost:3001')+'/api/auth'+path,{method:req.method,headers:fromNodeHeaders(req.headers),...(req.method==='POST'?{body:JSON.stringify(body)}:{})}));
   if(!response.ok)throw new AuthResponseError(response);
   if(path==='/change-password'||path==='/reset-password'){await invalidateResetLinks(c,user!);await c.query('SELECT public.revoke_identity_personal_tokens($1)',[user]);}
   if(req.method==='POST')await identityAudit(c,operation,'SUCCEEDED',req.id,user,path==='/change-password'||path==='/sign-out'?user:undefined);
   return path==='/request-password-reset'?Response.json({status:true,message:recoveryMessage}):response;
  });
  return deliver(response,reply);
 }catch(error){
  const outcome=error instanceof AuthResponseError?'REJECTED':(error as any)?.statusCode&& (error as any).statusCode<500?'REJECTED':'FAILED';
  // No request bodies, email addresses, tokens, headers, SQL errors or URLs in this ledger.
  await identityAudit(pool,operation,outcome,req.id,auditUser).catch(()=>{});
  if(error instanceof AuthResponseError)return deliver(error.response,reply);
  throw error;
 }finally{
  if(path==='/request-password-reset')await delay(Math.max(0,200+randomInt(0,31)-(Date.now()-started)));
 }
}
export async function accountSecurityRoutes(app:FastifyInstance){
 app.route({method:['GET','POST'],url:'/api/auth/*',bodyLimit:8192,handler:accountAuthHandler});
 // V7 F8: transactional mail moved to the platform administration (/v2/platform/mail).
}
