import {spawnSync} from 'node:child_process';

// Maintenance runs on the Docker host. PostgreSQL remains unpublished; resolve
// its current bridge address rather than persisting an address that can change.
export function backupDatabaseUrl() {
  const url=new URL(process.env.DATABASE_URL);
  if(url.hostname!=='postgres')return url.toString();
  if(process.platform!=='linux')throw Error('PRODUCTION_BACKUP_REQUIRES_LINUX_DOCKER_HOST');
  const inspected=spawnSync('docker',['inspect','--format','{{json .NetworkSettings.Networks}}',process.env.PG_CONTAINER||'commerce-os-postgres-1'],{encoding:'utf8'});
  if(inspected.status!==0)throw Error('POSTGRES_NETWORK_INSPECTION_FAILED');
  const networks=JSON.parse(inspected.stdout),chosen=process.env.PG_NETWORK;
  const candidates=chosen?[networks[chosen]]:Object.values(networks);
  if(candidates.length!==1||!candidates[0]?.IPAddress)throw Error('POSTGRES_NETWORK_MUST_BE_UNAMBIGUOUS');
  url.hostname=candidates[0].IPAddress;
  return url.toString();
}
