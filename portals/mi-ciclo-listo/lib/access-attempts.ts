import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const WINDOW_MS=15*60*1000;
const LIMIT=10;
let connection:DatabaseSync|undefined;
/** One private persistent database; no access codes, raw IPs or session cookies. */
export function accessAttempts(path=process.env.MCL_ACCESS_DB) {
 if(!path)throw new Error('ACCESS_ATTEMPT_STORAGE_NOT_CONFIGURED');
 const db=connection??=new DatabaseSync(path,{timeout:3000});
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS attempts (client TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL) STRICT');
 return {
  record(client:string,valid:boolean,now=Date.now()) {
   const key=createHash('sha256').update(client).digest('hex');
   db.exec('BEGIN IMMEDIATE');
   try {
    db.prepare('DELETE FROM attempts WHERE reset_at <= ?').run(now);
    const prior=db.prepare('SELECT count,reset_at FROM attempts WHERE client=?').get(key);
    if((prior&&Number(prior.count)>=LIMIT)||(!prior&&!valid&&Number(db.prepare('SELECT COUNT(*) AS n FROM attempts').get()?.n)>=50000)){db.exec('COMMIT');return false;}
    if(valid)db.prepare('DELETE FROM attempts WHERE client=?').run(key);
    else db.prepare('INSERT INTO attempts(client,count,reset_at) VALUES(?,1,?) ON CONFLICT(client) DO UPDATE SET count=count+1').run(key,now+WINDOW_MS);
    db.exec('COMMIT');return true;
   }catch(error){db.exec('ROLLBACK');throw error;}
  }
 };
}
