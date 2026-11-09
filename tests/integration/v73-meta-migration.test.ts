import {randomBytes,randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {withMigratedDatabase,fixtureProfileRow} from '../support/migrated-database.js';
import {migrate} from '../../packages/db/src/migrate.js';
import {encrypt,decrypt} from '../../packages/db/src/index.js';
import {readMetaConnectionToken} from '../../packages/db/src/meta-portfolios.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
describe('V7.2 → V7.3 additive adoption',()=>{
 it('preserves the exact old ciphertext and re-encapsulates it under its new connection identity',async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));
  try{await withMigratedDatabase('0118',async pool=>{
   const w='v73-migration-'+randomUUID(),token='EAAG'+randomBytes(24).toString('hex');await fixtureProfileRow(pool,[],w,{businessName:'Migration fixture',numbers:0});
   const ciphertext=encrypt({scope:'profile.meta.token.v1',workspaceId:w,revision:1,token});
   await pool.query('INSERT INTO meta_profile_credential_versions(workspace_id,revision,ciphertext,key_hint,created_by) VALUES($1,1,$2,$3,\'fixture\')',[w,ciphertext,token.slice(-4)]);
   await pool.query("INSERT INTO meta_profile_credentials(workspace_id,revision,updated_by) VALUES($1,1,'fixture')",[w]);await pool.query("UPDATE meta_profile_credentials SET state='VERIFIED',checked_at=now(),granted_scopes=ARRAY['ads_read'] WHERE workspace_id=$1",[w]);
   const prior=(await pool.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows;
   await migrate({pool,log:()=>undefined});await migrate({pool,log:()=>undefined});
   expect((await pool.query('SELECT name,sha256 FROM schema_migrations ORDER BY name')).rows.slice(0,118)).toEqual(prior);
   const conn=(await pool.query('SELECT * FROM meta_connections WHERE workspace_id=$1',[w])).rows[0];expect(conn).toMatchObject({legacy_revision:1,revision:1,state:'VERIFIED',auto_select_pending:true});
   const actual=await withProfileTransaction(pool,w,async db=>{await db.query("SET LOCAL ROLE commerce_automation");await db.query("SELECT set_config('app.environment','REAL',true)");return readMetaConnectionToken(db,conn.id,1);});expect(actual===token).toBe(true);
   const version=(await pool.query('SELECT ciphertext FROM meta_connection_versions WHERE workspace_id=$1',[w])).rows[0];const value=JSON.parse(decrypt(version.ciphertext));expect({scope:value.scope,connectionId:value.connectionId,revision:value.revision}).toEqual({scope:'profile.meta.connection.v1',connectionId:conn.id,revision:1});expect(value.token===token).toBe(true);
   expect((await pool.query('SELECT ciphertext FROM meta_profile_credential_versions WHERE workspace_id=$1',[w])).rows[0].ciphertext===ciphertext).toBe(true);
   await expect(pool.query('UPDATE meta_connections SET id=$2 WHERE workspace_id=$1',[w,randomUUID()])).rejects.toThrow('META_CONNECTION_IDENTITY_IMMUTABLE');
  });}finally{vi.unstubAllEnvs();}
 },60000);
});
