// Local E2E only: the API runs with its own runtime login, as in production
// (commerce_api_login → SET ROLE commerce_api, see packages/db/src/index.ts),
// so row policies and the SQL guards that require commerce_api apply. Never
// used with a non-loopback database or in production. The password is random
// per run and only lives in this process environment.
import pg from 'pg';
import {randomBytes} from 'node:crypto';
export async function provisionLocalApiLogin(env=process.env){
 if(env.NODE_ENV==='production')throw new Error('LOCAL_ROLE_LOGIN_TEST_ONLY');
 const url=new URL(env.DATABASE_URL??'');
 if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('LOCAL_ROLE_LOGIN_TEST_ONLY');
 const client=new pg.Client({connectionString:url.toString()});await client.connect();
 try{
  const ready=(await client.query("SELECT to_regrole('commerce_api') IS NOT NULL AS ok")).rows[0].ok;
  if(!ready)return null;
  const password=randomBytes(24).toString('hex');
  await client.query(`DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_api_login') THEN CREATE ROLE commerce_api_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION IN ROLE commerce_api; END IF; END$$`);
  await client.query(`ALTER ROLE commerce_api_login WITH LOGIN PASSWORD '${password}'`);
  await client.query('GRANT commerce_api TO commerce_api_login');
  const login=new URL(url.toString());login.username='commerce_api_login';login.password=password;
  return login.toString();
 }finally{await client.end();}
}
