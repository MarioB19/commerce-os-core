import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';
import {fixtureProfiles} from '../support/profile-fixture.js';

// V7 F4 materials (RF-06.c, UX-ASSET): a link and a private file uploaded in
// two parts, verified by size + SHA-256 + signature, previewed by its own
// profile only, and protected from removal while a published variant uses it.
const A='materials-'+randomUUID(),B='materials-other-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:Awaited<ReturnType<typeof createApp>>;const cookies:Record<string,string>={};
const call=(p:string,method:string,path:string,body?:unknown)=>app.inject({method:method as 'GET',url:path+(path.includes('?')?'&':'?')+'environment=REAL',payload:body as object,headers:{origin,cookie:cookies[p]!,'idempotency-key':randomUUID()}});
const data=(r:{statusCode:number;body:string;json():any},status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
async function login(profile:string){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Dueña',email,password,workspace_id:profile,role:'owner'});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 cookies[profile]=[r.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
}
beforeAll(async()=>{process.env.PRIVATE_STORAGE_DIR=await mkdtemp(join(tmpdir(),'materials-'));await fixtureProfiles(A,B);app=await createApp();await login(A);await login(B);});
afterAll(async()=>{await app.close();await pool.end();});

it('uploads, verifies, previews and protects private materials per profile',async()=>{
 const link=data(await call(A,'POST','/v2/materials',{kind:'link',name:'Portal sintético',url:'https://example.com/portal'}),201);
 expect(link).toMatchObject({kind:'link',status:'READY',host:'example.com'});
 expect((await call(A,'POST','/v2/materials',{kind:'link',name:'Inseguro',url:'http://example.com'})).statusCode).toBe(400);
 // 5 MiB PDF → two parts of 4 MiB + 1 MiB.
 const bytes=Buffer.concat([Buffer.from('%PDF-1.7\n'),randomBytes(5*1024*1024-9)]),sha=createHash('sha256').update(bytes).digest('hex');
 const file=data(await call(A,'POST','/v2/materials',{kind:'file',name:'Guía sintética',mime_type:'application/pdf',size_bytes:bytes.length,sha256:sha}),201);
 expect(file.upload).toEqual({part_bytes:4*1024*1024,parts:2});
 expect((await call(A,'POST',`/v2/materials/${file.id}/complete`,{})).json().error.code).toBe('MATERIAL_PART_MISSING');
 data(await call(A,'PUT',`/v2/materials/${file.id}/parts/1`,{base64:bytes.subarray(0,4*1024*1024).toString('base64')}));
 data(await call(A,'PUT',`/v2/materials/${file.id}/parts/2`,{base64:bytes.subarray(4*1024*1024).toString('base64')}));
 expect((await call(B,'PUT',`/v2/materials/${file.id}/parts/2`,{base64:bytes.subarray(4*1024*1024).toString('base64')})).statusCode).toBe(404);
 const ready=data(await call(A,'POST',`/v2/materials/${file.id}/complete`,{}));expect(ready.status).toBe('READY');
 const preview=await call(A,'GET',`/v2/materials/${file.id}/content`);
 expect(preview.statusCode).toBe(200);expect(preview.headers['content-type']).toContain('application/pdf');expect(createHash('sha256').update(preview.rawPayload).digest('hex')).toBe(sha);
 expect((await call(B,'GET',`/v2/materials/${file.id}/content`)).statusCode).toBe(404);
 // A wrong signature is refused at completion.
 const fake=Buffer.from('not a pdf at all');const bad=data(await call(A,'POST','/v2/materials',{kind:'file',name:'Falso',mime_type:'application/pdf',size_bytes:fake.length,sha256:createHash('sha256').update(fake).digest('hex')}),201);
 data(await call(A,'PUT',`/v2/materials/${bad.id}/parts/1`,{base64:fake.toString('base64')}));
 expect((await call(A,'POST',`/v2/materials/${bad.id}/complete`,{})).json().error.code).toBe('MATERIAL_TYPE_MISMATCH');
 data(await call(A,'POST',`/v2/materials/${bad.id}/cancel`,{}));
 // In use by a published variant: cannot be removed.
 const created=data(await call(A,'POST','/v2/products',{name:'Producto con material',variant:{name:'México',locale:{market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'}}}),201);
 let v=created.variant;
 v=data(await call(A,'PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:5000,fulfillment:[{asset_id:file.id,release_on:'receipt_approved'}]}}));
 v=data(await call(A,'PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:null,links:[{label:'Pagar',provider:'hotmart',url:'https://pay.example.com/p'}],instructions:''}}));
 data(await call(A,'POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 const listed=data(await call(A,'GET','/v2/materials'));
 expect(listed.find((m:{id:string})=>m.id===file.id)).toMatchObject({used_by_variants:1,status:'READY'});
 expect(listed.some((m:{id:string})=>m.id===bad.id)).toBe(false);
 expect((await call(A,'POST',`/v2/materials/${file.id}/archive`,{expected_version:ready.version})).json().error.code).toBe('MATERIAL_IN_USE');
 data(await call(A,'POST',`/v2/materials/${link.id}/archive`,{expected_version:link.version}));
 expect(data(await call(A,'GET','/v2/materials')).some((m:{id:string})=>m.id===link.id)).toBe(false);
 expect(data(await call(B,'GET','/v2/materials'))).toEqual([]);
},120000);
