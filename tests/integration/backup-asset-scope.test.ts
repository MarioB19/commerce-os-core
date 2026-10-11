import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterAll,describe,expect,it} from 'vitest';
import {hash,pool,putRecord} from '../../packages/db/src/index.js';

describe('production backup asset scope',()=>{
 const workspace=`backup-scope-${randomUUID()}`;
 afterAll(async()=>{await pool.end();});

 it('excludes metadata-only lab receipts while retaining physical SIMULATION assets',async()=>{
  const physicalKey=randomUUID()+'-'+hash('physical simulation asset');
  const physical=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'asset',body:{name:'Physical simulation asset',kind:'file',mime_type:'image/png',size_bytes:1,sha256:hash('physical simulation asset'),storage_key:physicalKey,status:'READY',lab_snapshot:true}});
  const placeholder=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'asset',body:{name:'Synthetic receipt placeholder',kind:'file',mime_type:'image/png',size_bytes:0,sha256:hash('metadata-only receipt'),storage_key:'simulation-'+randomUUID(),status:'READY',lab_snapshot:true,synthetic_receipt:true}});
  const source=readFileSync(resolve('scripts/backup.mjs'),'utf8');
  const match=source.match(/const assets=\(await db\.query\(("SELECT [^"]+")\)\)\.rows;/);
  expect(match?.[1]).toBeDefined();
  const query=JSON.parse(match![1]!) as string;
  const ids=(await pool.query(query)).rows.map(row=>row.id);
  expect(ids).toContain(physical.id);
  expect(ids).not.toContain(placeholder.id);
 });
});
