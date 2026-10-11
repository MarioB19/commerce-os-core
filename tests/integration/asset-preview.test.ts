import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {retirementFixture} from './platform-retirement-fixture.js';
import {pool,putRecord,encrypt} from '../../packages/db/src/index.js';
import {assetFilename,byteRange} from '../../apps/api/src/asset-preview.js';
import {storageDir} from '../../apps/api/src/catalog.js';
let f:Awaited<ReturnType<typeof retirementFixture>>;
const data=(r:any,status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
beforeAll(async()=>{f=await retirementFixture();});
afterAll(async()=>{await f.app.close();await pool.end();});
it('serves verified decrypted bytes, correct MIME, filename and browser seek ranges',async()=>{
 const bytes=Buffer.from('ID3 synthetic media bytes, never customer data'),asset=data(await f.call('POST','/v1/assets/upload-intents',{name:'Demostración de audio',kind:'file',mime_type:'audio/mpeg',size_bytes:bytes.length}),201);
 data(await f.call('PUT',`/v1/assets/${asset.id}/content`,{base64:bytes.toString('base64')}));data(await f.call('POST',`/v1/assets/${asset.id}/complete`,{}));
 const preview=await f.call('GET',`/v1/assets/${asset.id}/preview`);expect(data(preview)).toMatchObject({kind:'file',mime_type:'audio/mpeg'});expect(preview.headers['cache-control']).toContain('no-store');
 const response=await f.call('GET',`/v1/assets/${asset.id}/content?disposition=inline`);expect(response.rawPayload).toEqual(bytes);expect(response.headers['content-type']).toBe('audio/mpeg');expect(response.headers['content-disposition']).toContain('inline');expect(response.headers['content-disposition']).toContain('.mp3');expect(response.headers['accept-ranges']).toBe('bytes');
 for(const [range,expected] of [['bytes=2-7',bytes.subarray(2,8)],['bytes=-4',bytes.subarray(-4)],['bytes=4-',bytes.subarray(4)]] as const){const r=await f.app.inject({url:`/v1/assets/${asset.id}/content?environment=SIMULATION&disposition=inline`,headers:{cookie:f.cookie,range}});expect(r.statusCode).toBe(206);expect(r.rawPayload).toEqual(expected);}
 const invalid=await f.app.inject({url:`/v1/assets/${asset.id}/content?environment=SIMULATION`,headers:{cookie:f.cookie,range:'bytes=999999-'}});expect(invalid.statusCode).toBe(416);
 expect((await f.app.inject({url:`/v1/assets/${asset.id}/content?environment=SIMULATION`})).statusCode).toBe(401);
 expect((await f.app.inject({url:`/v1/assets/${asset.id}/preview?environment=REAL`,headers:{cookie:f.cookie}})).statusCode).toBe(404);
 const foreign=await putRecord(pool,{workspaceId:randomUUID(),environment:'SIMULATION',kind:'asset',body:{name:'Foreign',kind:'file',status:'READY'}});expect((await f.call('GET',`/v1/assets/${foreign.id}/preview`)).statusCode).toBe(404);
 const saved=data(await f.call('GET',`/v1/assets/${asset.id}`));expect(saved).not.toHaveProperty('storage_key');
 // Encryption remains at rest; a corrupt stored artifact cannot be streamed as a successful preview.
 const record=(await pool.query('SELECT body FROM records WHERE id=$1',[asset.id])).rows[0];const path=join(storageDir,'assets',record.body.storage_key+'.enc');const encrypted=await readFile(path,'utf8');expect(encrypted).not.toContain(bytes.toString());
 await writeFile(path,encrypt(Buffer.from('Different synthetic content').toString('base64')),{mode:0o600});expect((await f.call('GET',`/v1/assets/${asset.id}/content`)).statusCode).toBe(409);await writeFile(path,encrypted,{mode:0o600});
});
it('reveals a portal access only through its authenticated explicit preview, without granting delivery',async()=>{
 const asset=data(await f.call('POST','/v1/assets',{name:'Synthetic portal',kind:'access',adapter:'link',delivery_reference:JSON.stringify({url:'https://example.invalid/portal',code:'synthetic-code',instructions:'Fixture only'})}),201);
 expect(JSON.stringify(data(await f.call('GET',`/v1/assets/${asset.id}`)))).not.toContain('synthetic-code');
 const preview=await f.call('GET',`/v1/assets/${asset.id}/preview`);expect(data(preview)).toMatchObject({url:'https://example.invalid/portal',code:'synthetic-code'});expect(preview.headers['cache-control']).toContain('no-store');
 expect((await f.app.inject({url:`/v1/assets/${asset.id}/preview?environment=SIMULATION`})).statusCode).toBe(401);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[f.workspace])).rows[0].n).toBe(0);
});
it('handles suffix ranges and strips unsafe filename characters',()=>{
 expect(byteRange('bytes=-100',4)).toEqual({start:0,end:3});expect(()=>byteRange('bytes=0-1,3-4',6)).toThrow();expect(()=>byteRange('bytes=-0',6)).toThrow();expect(assetFilename('voice\r\n"/test','audio/mpeg')).not.toMatch(/[\r\n"/]/);
});
