import {describe, expect, it, vi} from 'vitest';
import type pg from 'pg';
import {withProfileTransaction, type ProfileExecutor, type ProfileConnection} from './profile-context.js';
const result = (rows: pg.QueryResultRow[] = []): pg.QueryResult => ({rows, command:'SELECT', rowCount:rows.length, oid:0, fields:[]});
function connection() {
  const calls: {sql:string;values?:readonly unknown[]}[] = [];
  let profile: string | undefined;
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    calls.push({sql, values});
    if (sql.includes('set_config')) profile = values?.[0] as string;
    if (sql === 'COMMIT' || sql === 'ROLLBACK') profile = undefined;
    return {...result(sql === 'SELECT profile' ? [{profile}] : []), command:sql==='COMMIT'?'COMMIT':'SELECT'};
  });
  return {calls, query, release:vi.fn(), get profile(){return profile;}};
}
function pool(c: ReturnType<typeof connection>) {return {connect: vi.fn(async () => c as ProfileConnection)};}

describe('profile transaction boundary', () => {
  it('installs a parameterized local profile before business work and clears it on commit', async () => {
    const c=connection(), p=pool(c), id="profile'quoted";
    const value=await withProfileTransaction(p,id,async db => (await db.query('SELECT profile')).rows[0].profile);
    expect(value).toBe(id); expect(c.profile).toBeUndefined();
    expect(c.calls.map(x=>x.sql)).toEqual(['BEGIN',"SELECT pg_catalog.set_config('app.workspace_id', $1, true)",'SET LOCAL row_security = on','SELECT profile','COMMIT']);
    expect(c.calls[1].values).toEqual([id]); expect(c.release).toHaveBeenCalledWith(undefined);
  });
  it('rejects missing context before acquiring a connection without requiring UUID-shaped legacy IDs', async () => {
    const p=pool(connection());
    for(const id of ['',null,undefined,'bad\0id']) await expect(withProfileTransaction(p,id as string,async()=>undefined)).rejects.toThrow('PROFILE_CONTEXT_REQUIRED');
    expect(p.connect).not.toHaveBeenCalled();
    await expect(withProfileTransaction(p,'legacy-team-1',async()=>true)).resolves.toBe(true);
  });
  it('rolls back a failed callback and recycles the same connection with the next profile',async()=>{
    const c=connection(),p=pool(c);
    await expect(withProfileTransaction(p,'one',async db=>{await db.query('SELECT profile');throw new Error('injected');})).rejects.toThrow('injected');
    expect(c.profile).toBeUndefined();
    expect(await withProfileTransaction(p,'two',async db=>(await db.query('SELECT profile')).rows[0].profile)).toBe('two');
    expect(c.calls.filter(x=>x.sql==='COMMIT')).toHaveLength(1);
    expect(c.calls.filter(x=>x.sql==='ROLLBACK')).toHaveLength(1);
  });
  it('isolates concurrent transactions even when callbacks interleave',async()=>{
    const a=connection(),b=connection();const p={connect:vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b)};
    let unblock!:()=>void;const barrier=new Promise<void>(r=>{unblock=r;});
    const one=withProfileTransaction(p,'one',async db=>{await barrier;return (await db.query('SELECT profile')).rows[0].profile;});
    const two=withProfileTransaction(p,'two',async db=>{const v=(await db.query('SELECT profile')).rows[0].profile;unblock();return v;});
    expect(await Promise.all([one,two])).toEqual(['one','two']);
  });
  it('invalidates an escaped executor after commit and rollback',async()=>{
    const c=connection(),p=pool(c);let escaped!:ProfileExecutor;
    await withProfileTransaction(p,'one',async db=>{escaped=db;});
    await expect(escaped.query('SELECT profile')).rejects.toThrow('PROFILE_TRANSACTION_CLOSED');
    await expect(withProfileTransaction(p,'two',async db=>{escaped=db;throw new Error('no');})).rejects.toThrow('no');
    await expect(escaped.query('SELECT profile')).rejects.toThrow('PROFILE_TRANSACTION_CLOSED');
    expect(c.calls.filter(x=>x.sql==='SELECT profile')).toHaveLength(0);
  });
  it('rolls back if setting the profile fails and never calls business code',async()=>{
    const c=connection(),p=pool(c),work=vi.fn();c.query.mockImplementationOnce(async()=>result()).mockRejectedValueOnce(new Error('context failed'));
    await expect(withProfileTransaction(p,'one',work)).rejects.toThrow('context failed');
    expect(work).not.toHaveBeenCalled();expect(c.calls.some(x=>x.sql==='ROLLBACK')).toBe(true);
  });
  it('discards uncertain connections when BEGIN or ROLLBACK fails, preserving the original error',async()=>{
    const a=connection();a.query.mockRejectedValueOnce(new Error('begin lost'));
    await expect(withProfileTransaction(pool(a),'one',async()=>1)).rejects.toThrow('begin lost');
    expect(a.release.mock.calls[0][0]).toHaveProperty('message','PROFILE_BEGIN_FAILED');
    const b=connection();const original=b.query.getMockImplementation()!;
    b.query.mockImplementation(async(sql,values)=>{if(sql==='ROLLBACK')throw new Error('transport');return original(sql,values);});
    await expect(withProfileTransaction(pool(b),'one',async()=>{throw new Error('business');})).rejects.toThrow('business');
    expect(b.release.mock.calls[0][0]).toHaveProperty('message','PROFILE_ROLLBACK_FAILED');
  });
  it('drains an unawaited query before rollback and refuses to commit',async()=>{
    const c=connection();const original=c.query.getMockImplementation()!;let complete!:()=>void;
    c.query.mockImplementation(async(sql,values)=>{if(sql==='WAIT')await new Promise<void>(r=>{complete=r;});return original(sql,values);});
    const action=withProfileTransaction(pool(c),'one',async db=>{void db.query('WAIT');});
    await vi.waitFor(()=>expect(complete).toBeTypeOf('function'));
    expect(c.calls.some(x=>x.sql==='COMMIT'||x.sql==='ROLLBACK')).toBe(false);complete();
    await expect(action).rejects.toThrow('PROFILE_QUERY_NOT_AWAITED');
    expect(c.calls.at(-1)?.sql).toBe('ROLLBACK');
  });
  it('drains a rejected forgotten query without an unhandled promise or a commit',async()=>{
    const c=connection(),original=c.query.getMockImplementation()!;let reject!: (reason:Error)=>void;
    c.query.mockImplementation(async(sql,values)=>{if(sql==='WAIT_FAIL')await new Promise<void>((_,r)=>{reject=r;});return original(sql,values);});
    const action=withProfileTransaction(pool(c),'one',async db=>{void db.query('WAIT_FAIL');});
    const outcome=expect(action).rejects.toThrow('PROFILE_QUERY_NOT_AWAITED');
    await vi.waitFor(()=>expect(reject).toBeTypeOf('function'));reject(new Error('late SQL failure'));
    await outcome;expect(c.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(c.calls.some(x=>x.sql==='COMMIT')).toBe(false);
  });
  it('never reports success after a consumer catches a failed SQL query',async()=>{
    const c=connection(),original=c.query.getMockImplementation()!;
    c.query.mockImplementation(async(sql,values)=>{if(sql==='FAIL')throw new Error('sql error');return original(sql,values);});
    await expect(withProfileTransaction(pool(c),'one',async db=>{try{await db.query('FAIL');}catch{/* caller cannot make a failed transaction successful */}return 'claimed success';})).rejects.toThrow('PROFILE_TRANSACTION_QUERY_FAILED');
    expect(c.calls.some(x=>x.sql==='COMMIT')).toBe(false);expect(c.calls.at(-1)?.sql).toBe('ROLLBACK');
  });
  it('requires native COMMIT confirmation, including aborted-transaction ROLLBACK responses',async()=>{
    const c=connection(),original=c.query.getMockImplementation()!;
    c.query.mockImplementation(async(sql,values)=>sql==='COMMIT'?{...result(),command:'ROLLBACK'}:original(sql,values));
    await expect(withProfileTransaction(pool(c),'one',async()=>true)).rejects.toThrow('PROFILE_COMMIT_UNCONFIRMED');
  });
  it('does not expose the raw connection or allow its profile property to be replaced',async()=>{
    await withProfileTransaction(pool(connection()),'one',async db=>{
      expect(Object.keys(db).sort()).toEqual(['query','workspaceId']);expect(Object.isFrozen(db)).toBe(true);
      expect(()=>Object.assign(db,{workspaceId:'two'})).toThrow();
    });
  });
});
