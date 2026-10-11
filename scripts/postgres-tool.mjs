import {join} from 'node:path';

// Docker remains the production default. Native mode is explicit, so recovery
// can be verified against an isolated local PostgreSQL without a Docker daemon.
// Connection secrets belong to the child's environment, never argv or logs.
export function postgresTool(tool,options={}){
 if(!['pg_dump','pg_restore'].includes(tool))throw Error('POSTGRES_TOOL_INVALID');
 const source=options.env??process.env;
 let url,database;
 try{url=new URL(options.databaseUrl??source.DATABASE_URL);database=options.database??decodeURIComponent(url.pathname.slice(1));}
 catch{throw Error('POSTGRES_DATABASE_URL_INVALID');}
 if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('POSTGRES_DATABASE_URL_INVALID');
 if(!database)throw Error('POSTGRES_DATABASE_REQUIRED');
 const mode=source.POSTGRES_TOOLS_MODE??'docker',args=options.args??[];
 if(mode==='docker'){
  if(source.PGAPPNAME&&!/^[A-Za-z0-9._-]{1,63}$/.test(source.PGAPPNAME))throw Error('POSTGRES_APPLICATION_NAME_INVALID');
  return{command:'docker',args:['exec',...(tool==='pg_restore'?['-i']:[]),...(source.PGAPPNAME?['--env','PGAPPNAME='+source.PGAPPNAME]:[]),source.PG_CONTAINER||'commerce-os-local-postgres-1',tool,...args,'-U',source.POSTGRES_USER||'commerce','-d',database],env:source};
 }
 if(mode!=='native')throw Error('POSTGRES_TOOLS_MODE_INVALID');
 let user,password;
 try{user=decodeURIComponent(url.username);password=decodeURIComponent(url.password);}catch{throw Error('POSTGRES_DATABASE_URL_INVALID');}
 const env={...source,PGHOST:url.hostname.replace(/^\[|\]$/g,'')||'127.0.0.1',PGPORT:url.port||'5432',PGUSER:user,PGPASSWORD:password,PGDATABASE:database};
 if(url.searchParams.has('sslmode'))env.PGSSLMODE=url.searchParams.get('sslmode');
 // pg_restore requires -d to execute the archive; PGDATABASE alone would leave
 // it in SQL-output mode. The database name is not a connection credential.
 return{command:source.POSTGRES_BIN_DIR?join(source.POSTGRES_BIN_DIR,tool):tool,args:[...args,'-d',database],env};
}
