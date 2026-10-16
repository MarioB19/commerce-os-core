import {afterEach,describe,expect,it,vi} from 'vitest';
import {loginInvitationSession} from './invitation-login.js';
const body={email:'recipient@example.invalid',password:'synthetic-password'};
afterEach(()=>vi.unstubAllGlobals());
describe('invitation native login transport',()=>{
 it('sends one closed request and exposes no response identity',async()=>{const call=vi.fn(async()=>Response.json({user:{id:'not-accepted-as-identity'},token:'not-stored'}));vi.stubGlobal('fetch',call);expect(await loginInvitationSession(body)).toBeUndefined();expect(call).toHaveBeenCalledTimes(1);const [url,init]=call.mock.calls[0] as any;expect(url).toBe('/api/auth/sign-in/email');expect(JSON.parse(init.body)).toEqual(body);expect(init).toMatchObject({credentials:'include',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',method:'POST'});expect(init.headers).toEqual({'Content-Type':'application/json'});});
 it.each([400,401,409,429,500])('status %s remains unconfirmed and is never retried',async status=>{const call=vi.fn(async()=>Response.json({error:{message:'do not display secret'}},{status}));vi.stubGlobal('fetch',call);await expect(loginInvitationSession(body)).rejects.toMatchObject({code:'INVITATION_LOGIN_UNCONFIRMED',status:0});expect(call).toHaveBeenCalledTimes(1);});
 it('lost response is unconfirmed without a second request',async()=>{const call=vi.fn(async()=>{throw Error('secret diagnostic');});vi.stubGlobal('fetch',call);await expect(loginInvitationSession(body)).rejects.not.toThrow('secret diagnostic');expect(call).toHaveBeenCalledTimes(1);});
 it('oversized native response is unconfirmed',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('x'.repeat(8193))));await expect(loginInvitationSession(body)).rejects.toMatchObject({code:'INVITATION_LOGIN_UNCONFIRMED'});});
 it('invalid or extra login fields never reach HTTP',async()=>{const call=vi.fn();vi.stubGlobal('fetch',call);await expect(loginInvitationSession({...body,token:'never sent'} as any)).rejects.toThrow();await expect(loginInvitationSession({...body,email:'x'.repeat(255)})).rejects.toThrow();expect(call).not.toHaveBeenCalled();});
});
