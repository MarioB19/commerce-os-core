import {randomBytes,randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {encrypt,hash} from './index.js';
import {enrollCurrentQrWarmup,enrollQrWarmupProfile} from './qr-warmup.js';
import {readCurrentQrContinuity} from './continuous-warmup.js';
import type {ProfileExecutor} from './profile-context.js';
import type {ContinuousAuthorization} from '../../contracts/src/continuous-authorization.js';
vi.mock('./continuous-warmup.js',()=>({readCurrentQrContinuity:vi.fn()}));
const account=randomUUID(),grantId=randomUUID(),connection=randomUUID(),raw='15550000000@c.us',workspace='synthetic-qr-profile';
let grant:ContinuousAuthorization;
beforeEach(()=>{vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));grant={id:grantId,workspaceId:workspace,environment:'REAL',accountId:account,source:{kind:'VERIFIED_QR_CONNECTION',connectionId:connection,identityFingerprint:hash(raw)},createdBy:'fixture',createdAt:new Date().toISOString(),version:1,humanPaused:false,revokedAt:null,protections:[]};vi.mocked(readCurrentQrContinuity).mockResolvedValue(grant);});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
function db(row:object,result:object={state:'ENROLLED',pool_id:randomUUID(),episode_id:randomUUID(),identity_id:randomUUID()}){return{workspaceId:workspace,query:vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT revision')?[row]:[{result}],rowCount:1}))}as unknown as ProfileExecutor;}
describe('QR enrollment consumes native ciphertext only',()=>{
 it('passes matching ciphertext/revision and canonical encrypted address to the closed SQL function',async()=>{
  const row={revision:7,observed_identity_ciphertext:encrypt(raw),expected_identity_fingerprint:hash(raw)},c=db(row);
  expect((await enrollCurrentQrWarmup(c,'REAL',account)).state).toBe('ENROLLED');
  const call=vi.mocked(c.query).mock.calls[1];expect(call[1]?.slice(0,6)).toEqual(['REAL',account,grantId,7,row.observed_identity_ciphertext,hash('wa:15550000000')]);
  expect(call[1]?.[6]).not.toContain(raw);
 });
 it('rejects missing current connection before any identity read',async()=>{vi.mocked(readCurrentQrContinuity).mockResolvedValue(undefined);const c=db({});await expect(enrollCurrentQrWarmup(c,'REAL',account)).rejects.toThrow('QR_CURRENT_CONNECTION_REQUIRED');expect(c.query).not.toHaveBeenCalled();});
 it.each(['bad-ciphertext','changed','opaque'])('rejects %s without SQL enrollment',async kind=>{
  const value=kind==='opaque'?'unmapped@lid':raw;
  if(kind==='opaque')grant.source={kind:'VERIFIED_QR_CONNECTION',connectionId:connection,identityFingerprint:hash(value)};
  const c=db({revision:1,observed_identity_ciphertext:kind==='bad-ciphertext'?'bad':encrypt(kind==='changed'?'15558888888@c.us':value),expected_identity_fingerprint:hash(value)});
  await expect(enrollCurrentQrWarmup(c,'REAL',account)).rejects.toThrow();expect(c.query).toHaveBeenCalledTimes(1);
 });
 it('rejects an unbounded scan before querying',async()=>{const c=db({});for(const limit of [0,101,1.1])await expect(enrollQrWarmupProfile(c,'REAL',limit)).rejects.toThrow('QR_ENROLLMENT_LIMIT');expect(c.query).not.toHaveBeenCalled();});
 it('does not reinterpret preserved legacy membership as successful enrollment',async()=>{const c=db({revision:1,observed_identity_ciphertext:encrypt(raw),expected_identity_fingerprint:hash(raw)},{state:'LEGACY_ADOPTION_REQUIRED'});expect(await enrollCurrentQrWarmup(c,'REAL',account)).toEqual({state:'LEGACY_ADOPTION_REQUIRED'});});
});
