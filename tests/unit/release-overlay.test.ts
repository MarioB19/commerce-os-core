import {describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'commerce-overlay-')),privateDir=join(root,'private'),bin=join(root,'bin'),capture=join(root,'capture');mkdirSync(privateDir);mkdirSync(bin);
 writeFileSync(join(bin,'docker'),'#!/bin/sh\nif [ "$1" = ps ]; then printf "%s" "$EXISTING_GATEWAY"; exit 0; fi\nprintf "%s\\n" "$@" > "$COMMAND_CAPTURE"\n',{mode:0o700});
 const env=join(privateDir,'release.env');writeFileSync(env,`COMMERCE_SECRETS_DIR=${privateDir}\nINERT=$(touch ${root}/must-not-execute)\n`);
 const run=(extra:Record<string,string>={})=>spawnSync('sh',[resolve('scripts/compose-release.sh'),env,'up','-d','--no-deps','api'],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,COMMAND_CAPTURE:capture,COMMERCE_PILOT_RELEASE_ENV:'',EXISTING_GATEWAY:'',...extra}});
 const pilot=()=>{const dir=join(privateDir,'pilot');mkdirSync(dir);writeFileSync(join(dir,'pilot-release.env'),`COMMERCE_GATEWAY_CONFIG_DIR=${dir}\n`);for(const file of ['channel-pilot','ingress-pilot','waha-01'])writeFileSync(join(dir,file+'.env'),'FIXTURE_ONLY=true\n');return join(dir,'pilot-release.env');};
 return{root,env,capture,run,pilot,clean:()=>rmSync(root,{recursive:true,force:true})};
}
describe('Release composition preserves gateway configuration',()=>{
 it('verifies installer isolation decisions using only synthetic container states',()=>{const result=spawnSync('python3',[resolve('scripts/test-ownership-isolation-receipts.py')],{encoding:'utf8'});expect(result.status,result.stderr).toBe(0);expect(Number(result.stderr.match(/Ran (\d+) tests/)?.[1])).toBeGreaterThanOrEqual(18);});
 it('discovers the existing pilot and carries both files/profile through a core recreate',()=>{const f=fixture();try{const pilot=f.pilot(),result=f.run({EXISTING_GATEWAY:'stopped-gateway'});expect(result.status,result.stderr).toBe(0);const args=readFileSync(f.capture,'utf8').trim().split('\n');expect(args).toEqual(['compose','--env-file',f.env,'--env-file',pilot,'-f','infra/compose/production.yaml','-f','infra/compose/pilot.yaml','--profile','waha-pilot','up','-d','--no-deps','api']);expect(existsSync(join(f.root,'must-not-execute'))).toBe(false);}finally{f.clean();}});
 it('blocks any gateway-owning installation without a pilot file, including a stopped gateway',()=>{const f=fixture();try{const result=f.run({EXISTING_GATEWAY:'stopped-gateway'});expect(result.status).toBe(2);expect(result.stderr).toContain('refusing a core-only update');expect(existsSync(f.capture)).toBe(false);}finally{f.clean();}});
 it('blocks an explicit missing configuration and an incomplete pilot',()=>{const f=fixture();try{expect(f.run({COMMERCE_PILOT_RELEASE_ENV:join(f.root,'missing.env')}).status).toBe(2);f.pilot();rmSync(join(f.root,'private/pilot/channel-pilot.env'));expect(f.run().status).toBe(2);expect(existsSync(f.capture)).toBe(false);}finally{f.clean();}});
 it('allows first installation of the core without provisioning a gateway',()=>{const f=fixture();try{expect(f.run().status).toBe(0);const args=readFileSync(f.capture,'utf8');expect(args).toContain('infra/compose/production.yaml');expect(args).not.toContain('pilot.yaml');expect(args).not.toContain('waha-pilot');}finally{f.clean();}});
 it('rejects legacy rollback images before Compose or operational mutations and permits compatible images to reach preflight',()=>{
  const f=fixture();try{
   writeFileSync(f.env,`COMMERCE_IMAGE=sha256:${'1'.repeat(64)}\nCOMMERCE_WEB_IMAGE=sha256:${'2'.repeat(64)}\nCOMMERCE_SECRETS_DIR=${join(f.root,'private')}\n`);
   writeFileSync(join(f.root,'bin/docker'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_CAPTURE"\ncase "$*" in\n *operational-settings.ts*) exit "$POLICY_SUPPORTED_EXIT";;\n "image inspect --format {{.Architecture}} "*) echo amd64;;\n "image inspect --format {{.Os}} "*) echo linux;;\n "compose "*) exit 73;;\nesac\n',{mode:0o700});
   const run=(exit:string)=>spawnSync('sh',[resolve('scripts/release.sh'),'rollback',f.env],{encoding:'utf8',env:{...process.env,PATH:join(f.root,'bin')+':'+process.env.PATH,COMMAND_CAPTURE:f.capture,COMMERCE_PILOT_RELEASE_ENV:'',POLICY_SUPPORTED_EXIT:exit}});
   const legacy=run('42');expect(legacy.status).toBe(2);expect(legacy.stderr).toContain('does not support database operational policy');let commands=readFileSync(f.capture,'utf8');expect(commands).toContain('--network none --read-only --cap-drop ALL');expect(commands).not.toContain('compose ');expect(commands).not.toContain(' stop ');
   writeFileSync(f.capture,'');const compatible=run('0');expect(compatible.status).toBe(73);commands=readFileSync(f.capture,'utf8');expect(commands).toContain('config --quiet');expect(commands).not.toContain(' stop ');
  }finally{f.clean();}
 });
});
