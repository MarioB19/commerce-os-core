import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
export const configDir = process.env.COMMERCE_CONFIG_DIR || join(homedir(), '.config', 'commerce-os-local');
export function localEnv() {
  const path = join(configDir, 'runtime.env');
  try { return Object.fromEntries(readFileSync(path,'utf8').split('\n').filter(s=>s && !s.startsWith('#')).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];})); }
  catch { throw new Error(`Falta configuración privada. Ejecuta pnpm local:setup (${path}).`); }
}
export function applyLocalEnv() { let env; try { env=localEnv(); } catch(error) { if(process.env.DATABASE_URL)return;throw error; } for (const [k,v] of Object.entries(env)) process.env[k] ??= v; }
