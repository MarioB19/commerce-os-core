import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,rename,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {putRecord,encrypt,decrypt,appendEvent} from './index.js';
import type {ProfileExecutor} from './profile-context.js';
import type {Body} from '../../contracts/src/index.js';

/** V7 F4 materials (RF-06.c, materials_manage): private files and links of one
 * profile. Files are encrypted at rest in the installation's private store
 * (replicated to the private GCS bucket by the F1 job; no R2). Uploads are
 * resumable in parts and sealed by size + SHA-256 + file signature. */
export class MaterialError extends Error{constructor(readonly code:string,readonly statusCode=409){super(code);}}
function need(value:unknown,code:string,status=409):asserts value{if(!value)throw new MaterialError(code,status);}
type Environment='REAL'|'SIMULATION';
interface Actor {id:string;kind:'human'|'personal_api'}
export const materialMimeTypes=['application/pdf','image/jpeg','image/png','audio/mpeg','audio/ogg','video/mp4','text/plain'] as const;
export const MATERIAL_MAX_BYTES=20*1024*1024,MATERIAL_PART_BYTES=4*1024*1024;
const id=z.string().uuid().transform(v=>v.toLowerCase());
export const materialCreateSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('link'),name:z.string().trim().min(1).max(160),url:z.string().trim().max(2000).url().refine(v=>{try{const u=new URL(v);return u.protocol==='https:'&&!u.username&&!u.password;}catch{return false;}},'El enlace debe empezar con https://')}).strict(),
 z.object({kind:z.literal('file'),name:z.string().trim().min(1).max(160),mime_type:z.enum(materialMimeTypes),size_bytes:z.number().int().min(1).max(MATERIAL_MAX_BYTES),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export const materialListSchema=z.object({q:z.string().trim().max(160).optional(),include:z.enum(['active','all']).default('active')}).strict();
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const signatures:Record<string,(b:Buffer)=>boolean>={'application/pdf':b=>b.subarray(0,5).toString()==='%PDF-','image/png':b=>b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
 'image/jpeg':b=>b[0]===255&&b[1]===216&&b[2]===255,'audio/ogg':b=>b.subarray(0,4).toString()==='OggS','video/mp4':b=>b.subarray(4,8).toString()==='ftyp',
 'audio/mpeg':b=>b.subarray(0,3).toString()==='ID3'||b[0]===0xff&&(b[1]!&0xe0)===0xe0,'text/plain':b=>!b.includes(0)};
export const privateStorageRoot=()=>process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR??join(process.env.HOME??'/tmp','.local/share/commerce-os-private');

function view(row:{id:string;version:number;body:Body;created_at:string},references:number){
 const b=row.body;
 return{id:row.id,version:row.version,name:String(b.name??'Material'),kind:b.kind as string,mime_type:b.mime_type??null,size_bytes:b.size_bytes??0,
  status:b.status as string,status_label:({READY:'Listo',UPLOAD_PENDING:'Subiendo',UPLOADED:'Por verificar',CANCELLED:'Cancelado',ARCHIVED:'Eliminado'} as Record<string,string>)[b.status]??String(b.status),
  host:b.kind==='link'&&typeof b.url==='string'?new URL(b.url).hostname:null,deliverable:b.delivery_eligible!==false&&b.usage!=='MARKETING_REFERENCE',
  archived:!!b.archived_at,used_by_variants:references,created_at:new Date(row.created_at).toISOString()};
}
async function references(db:ProfileExecutor,environment:Environment,assetId:string){
 return(await db.query(`SELECT count(DISTINCT variant_id)::int n FROM market_releases WHERE workspace_id=$1 AND environment=$2 AND body->'configuration'->'materials' @> jsonb_build_array(jsonb_build_object('id',$3::text))`,[db.workspaceId,environment,assetId])).rows[0].n as number;
}
async function material(db:ProfileExecutor,environment:Environment,assetId:string,lock=false){
 const row=(await db.query(`SELECT id,version,body,created_at FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='asset' AND id=$3${lock?' FOR UPDATE':''}`,[db.workspaceId,environment,id.parse(assetId)])).rows[0];
 need(row,'MATERIAL_NOT_FOUND',404);return row as {id:string;version:number;body:Body;created_at:string};
}
export async function listMaterials(db:ProfileExecutor,environment:Environment,input:unknown){
 const q=materialListSchema.parse(input??{});
 const rows=(await db.query(`SELECT r.id,r.version,r.body,r.created_at,(SELECT count(DISTINCT m.variant_id)::int FROM market_releases m WHERE m.workspace_id=r.workspace_id AND m.environment=r.environment
   AND m.body->'configuration'->'materials' @> jsonb_build_array(jsonb_build_object('id',r.id::text))) AS refs
  FROM records r WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='asset' AND NOT (r.body ? 'lab_material_placeholder')
  AND ($3 OR (NOT (r.body ? 'archived_at') AND COALESCE(r.body->>'status','') NOT IN('ARCHIVED','CANCELLED','RETAINED')))
  AND ($4::text IS NULL OR r.body->>'name' ILIKE '%'||$4||'%') ORDER BY r.created_at DESC,r.id LIMIT 500`,[db.workspaceId,environment,q.include==='all',q.q?q.q.replace(/[%_\\]/g,m=>'\\'+m):null])).rows;
 return rows.map(r=>view(r,r.refs));
}
export async function readMaterial(db:ProfileExecutor,environment:Environment,assetId:string){const row=await material(db,environment,assetId);return view(row,await references(db,environment,row.id));}
export async function createMaterial(db:ProfileExecutor,environment:Environment,input:unknown,actor:Actor){
 const q=materialCreateSchema.parse(input);
 const body:Body=q.kind==='link'?{name:q.name,kind:'link',url:q.url,status:'READY',source:'v7_material'}:{name:q.name,kind:'file',mime_type:q.mime_type,size_bytes:q.size_bytes,sha256:q.sha256,status:'UPLOAD_PENDING',source:'v7_material'};
 const row=await putRecord(db,{workspaceId:db.workspaceId,environment,kind:'asset',body});
 await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'material.created',aggregate_id:row.id,actor:{type:actor.kind,id:actor.id},payload:{kind:q.kind}});
 return{...view(row,0),upload:q.kind==='file'?{part_bytes:MATERIAL_PART_BYTES,parts:Math.ceil(q.size_bytes/MATERIAL_PART_BYTES)}:null};
}
function partsDir(assetId:string){return join(privateStorageRoot(),'uploads',assetId);}
export async function putMaterialPart(db:ProfileExecutor,environment:Environment,assetId:string,index:number,base64:string){
 const row=await material(db,environment,assetId,true);
 need(row.body.kind==='file'&&row.body.status==='UPLOAD_PENDING','MATERIAL_NOT_UPLOADING');
 const parts=Math.ceil(Number(row.body.size_bytes)/MATERIAL_PART_BYTES);need(Number.isInteger(index)&&index>=1&&index<=parts,'MATERIAL_PART_INVALID',400);
 need(/^[A-Za-z0-9+/]*={0,2}$/.test(base64),'MATERIAL_PART_INVALID',400);const bytes=Buffer.from(base64,'base64');
 const expected=index<parts?MATERIAL_PART_BYTES:Number(row.body.size_bytes)-(parts-1)*MATERIAL_PART_BYTES;need(bytes.length===expected,'MATERIAL_PART_SIZE',400);
 const dir=partsDir(row.id);await mkdir(dir,{recursive:true,mode:0o700});
 const target=join(dir,`${index}.part`),temporary=`${target}.${randomUUID()}.tmp`;
 await writeFile(temporary,encrypt(bytes.toString('base64')),{mode:0o600});await rename(temporary,target);
 return{id:row.id,part:index,parts,part_sha256:sha(bytes)};
}
export async function completeMaterial(db:ProfileExecutor,environment:Environment,assetId:string,actor:Actor){
 const row=await material(db,environment,assetId,true);
 if(row.body.status==='READY')return view(row,await references(db,environment,row.id));
 need(row.body.kind==='file'&&row.body.status==='UPLOAD_PENDING','MATERIAL_NOT_UPLOADING');
 const parts=Math.ceil(Number(row.body.size_bytes)/MATERIAL_PART_BYTES),dir=partsDir(row.id),chunks:Buffer[]=[];
 for(let i=1;i<=parts;i++){let content:string;try{content=await readFile(join(dir,`${i}.part`),'utf8');}catch{throw new MaterialError('MATERIAL_PART_MISSING',409);}chunks.push(Buffer.from(decrypt(content),'base64'));}
 const bytes=Buffer.concat(chunks);
 need(bytes.length===row.body.size_bytes&&sha(bytes)===row.body.sha256,'MATERIAL_CHECKSUM_MISMATCH');
 need(signatures[row.body.mime_type]?.(bytes)!==false,'MATERIAL_TYPE_MISMATCH',400);
 const storageKey=`${row.id}-${row.body.sha256}`,assets=join(privateStorageRoot(),'assets');await mkdir(assets,{recursive:true,mode:0o700});
 const path=join(assets,storageKey+'.enc'),temporary=`${path}.${randomUUID()}.tmp`;
 await writeFile(temporary,encrypt(bytes.toString('base64')),{mode:0o600});await rename(temporary,path);
 const saved=await putRecord(db,{id:row.id,workspaceId:db.workspaceId,environment,kind:'asset',version:row.version,body:{...row.body,storage_key:storageKey,status:'READY'}});
 await rm(dir,{recursive:true,force:true});
 await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'material.uploaded',aggregate_id:row.id,actor:{type:actor.kind,id:actor.id},payload:{size_bytes:bytes.length,sha256:row.body.sha256}});
 return view(saved,0);
}
export async function cancelMaterial(db:ProfileExecutor,environment:Environment,assetId:string,actor:Actor){
 const row=await material(db,environment,assetId,true);need(row.body.status==='UPLOAD_PENDING','MATERIAL_NOT_UPLOADING');
 const saved=await putRecord(db,{id:row.id,workspaceId:db.workspaceId,environment,kind:'asset',version:row.version,body:{...row.body,status:'CANCELLED'}});
 await rm(partsDir(row.id),{recursive:true,force:true});
 await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'material.cancelled',aggregate_id:row.id,actor:{type:actor.kind,id:actor.id},payload:{}});return view(saved,0);
}
/** "Eliminar" hides a material from new configurations. A published variant
 * that pins it keeps delivering it; history and stored bytes are untouched. */
export async function archiveMaterial(db:ProfileExecutor,environment:Environment,assetId:string,expectedVersion:number,actor:Actor){
 const row=await material(db,environment,assetId,true);need(row.version===expectedVersion,'VERSION_CONFLICT');need(!row.body.archived_at,'MATERIAL_ARCHIVED');
 const active=(await db.query(`SELECT count(*)::int n FROM market_variants v JOIN market_releases r ON r.workspace_id=v.workspace_id AND r.environment=v.environment AND r.id=v.current_release_id
  WHERE v.workspace_id=$1 AND v.environment=$2 AND v.archived_at IS NULL AND r.body->'configuration'->'materials' @> jsonb_build_array(jsonb_build_object('id',$3::text))`,[db.workspaceId,environment,row.id])).rows[0].n;
 need(active===0,'MATERIAL_IN_USE');
 const saved=await putRecord(db,{id:row.id,workspaceId:db.workspaceId,environment,kind:'asset',version:row.version,body:{...row.body,archived_at:new Date().toISOString()}});
 await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'material.archived',aggregate_id:row.id,actor:{type:actor.kind,id:actor.id},payload:{}});return view(saved,0);
}
/** Bytes for an authorized preview; integrity re-checked on every read. */
export async function materialBytes(db:ProfileExecutor,environment:Environment,assetId:string){
 const row=await material(db,environment,assetId);need(row.body.kind==='file'&&row.body.status==='READY','MATERIAL_NOT_READY');
 const key=String(row.body.storage_key??'');need(/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(key)&&!row.body.storage_provider,'MATERIAL_STORAGE_UNAVAILABLE');
 const bytes=Buffer.from(decrypt(await readFile(join(privateStorageRoot(),'assets',key+'.enc'),'utf8')),'base64');
 need(bytes.length===row.body.size_bytes&&sha(bytes)===row.body.sha256,'MATERIAL_INTEGRITY_FAILED');
 return{bytes,mime:String(row.body.mime_type),name:String(row.body.name??'material')};
}
/** Abandoned resumable uploads older than a day are removed (maintenance). */
export async function sweepMaterialUploads(olderThanMs=86_400_000){
 const root=join(privateStorageRoot(),'uploads');let names:string[];try{names=await readdir(root);}catch{return 0;}
 let removed=0;const {stat}=await import('node:fs/promises');
 for(const name of names){if(!/^[a-f0-9-]{36}$/.test(name))continue;const s=await stat(join(root,name));if(Date.now()-s.mtimeMs>olderThanMs){await rm(join(root,name),{recursive:true,force:true});removed++;}}
 return removed;
}
