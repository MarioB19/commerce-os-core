import {expect,it} from 'vitest';
import pg from 'pg';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

it('survives an idle PostgreSQL connection loss and reconnects without logging private details',async()=>{
  const admin=new pg.Client({connectionString:process.env.DATABASE_URL});
  const marker='recovery-test-'+randomUUID();
  const source=new URL('../../packages/db/src/index.ts',import.meta.url).href;
  // A separate process has no test-added pool error listener: removing the production
  // listener must crash this child, which verifies the actual EventEmitter failure path.
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',`
    import {pool} from ${JSON.stringify(source)};
    const client=await pool.connect();
    const {rows}=await client.query('SELECT pg_backend_pid() AS pid');
    const previous=rows[0].pid;
    client.release();
    process.on('message',async()=>{
      try {
        const deadline=Date.now()+5000;
        while(pool.totalCount!==0 && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
        if(pool.totalCount!==0) throw new Error('IDLE_CLIENT_NOT_DISCARDED');
        const next=await pool.query('SELECT 1 AS ok,pg_backend_pid() AS pid');
        process.send({recovered:next.rows[0].ok===1 && next.rows[0].pid!==previous});
        await pool.end();process.disconnect();
      } catch { process.stderr.write('recovery_verification_failed\\n');process.exit(1); }
    });
    process.send({idle_pid:previous});
  `],{env:{...process.env,PGAPPNAME:marker},stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=String(chunk);});
  const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  const idle=new Promise<number>((resolve,reject)=>{
    child.on('message',(message:any)=>{if(message.idle_pid)resolve(message.idle_pid);});
    child.once('exit',()=>reject(new Error('Recovery child exited before establishing idle connection')));
  });
  const recovered=new Promise<boolean>((resolve,reject)=>{
    child.on('message',(message:any)=>{if('recovered' in message)resolve(message.recovered);});
    child.once('exit',()=>reject(new Error('Recovery child exited before reconnecting')));
  });
  // Attach early to avoid an unhandled test promise if setup itself fails.
  void recovered.catch(()=>{});
  try {
    await admin.connect();
    const pid=await idle;
    const result=await admin.query(`SELECT pg_terminate_backend(pid) AS terminated
      FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND application_name=$2`,[pid,marker]);
    expect(result.rows).toEqual([{terminated:true}]);
    child.send('reconnect');
    expect(await recovered).toBe(true);
    expect(await exited).toBe(0);
    expect(stderr).toBe('database_idle_connection_failed; reconnecting on next query\n');
  } finally {
    child.kill();
    await admin.end();
  }
});
