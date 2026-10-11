import { mkdirSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { configDir, localEnv } from './local-env.mjs';
mkdirSync(configDir,{recursive:true,mode:0o700}); chmodSync(configDir,0o700);
const envPath=join(configDir,'runtime.env');
if (!existsSync(envPath)) {
 const pgpass=randomBytes(24).toString('hex');
 const cfg={NODE_ENV:'development',POSTGRES_USER:'commerce',POSTGRES_PASSWORD:pgpass,POSTGRES_DB:'commerce',DATABASE_URL:`postgresql://commerce:${pgpass}@127.0.0.1:5440/commerce`,BACKUP_ENCRYPTION_KEY:randomBytes(32).toString('hex'),BETTER_AUTH_SECRET:randomBytes(32).toString('hex'),BETTER_AUTH_URL:'http://127.0.0.1:5173',TRUSTED_ORIGINS:'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:4173',DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex'),ASSET_STORAGE_DIR:join(configDir,'assets'),PRIVATE_STORAGE_DIR:join(configDir,'assets'),DISPATCH_FROZEN:'true',REAL_SENDS_ENABLED:'false',ALLOW_REAL_OPERATIONS:'false',ALLOW_CHANNEL_ONBOARDING:'false',API_PORT:'3001',PORT:'3001',INGRESS_PORT:'3002',CHANNEL_PORT:'3004',CHANNEL_INTERNAL_URL:'http://127.0.0.1:3004',INTERNAL_SERVICE_TOKEN:randomBytes(32).toString('hex'),CHANNEL_INTERNAL_TOKEN:randomBytes(32).toString('hex'),SIMULATOR_INGRESS_TOKEN:randomBytes(32).toString('hex'),INTERNAL_API_TOKEN:randomBytes(32).toString('hex'),BOOTSTRAP_EMAIL:'owner@commerce.test',BOOTSTRAP_NAME:'Operador local',BOOTSTRAP_PASSWORD:randomBytes(24).toString('base64url'),WORKSPACE_ID:'local',LOG_LEVEL:'warn'};
 writeFileSync(envPath,Object.entries(cfg).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
}
const env=localEnv(); mkdirSync(env.PRIVATE_STORAGE_DIR,{recursive:true,mode:0o700});
const args=['compose','--env-file',envPath,'-f','infra/compose/local.yaml','up','-d','--wait'];
const r=spawnSync('docker',args,{stdio:'inherit'}); if(r.status!==0)process.exit(r.status||1);
console.log('PostgreSQL local listo. Configuración y acceso inicial en directorio privado (permisos 0700/0600).');
console.log('Siguiente: pnpm db:migrate, pnpm bootstrap, pnpm dev.');
