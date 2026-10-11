import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
// @ts-expect-error The distributable Node CLI is intentionally plain JavaScript; tests exercise its runtime boundary.
import {canonicalJson,digest,prepareInputs,openJournal,createStudioClient,uploadAsset,remapRecipe,validateQa,validateArtifacts,downloadVerified,QA_CODES,studioRoute,parseArgs,validatePreferredWorker,submitPilot,browserFirstSelection,verifyBrowserInputRecipe,importPilot} from '../../scripts/creative-studio-pilot.mjs';
import {sha256Value} from '../../packages/creative-engine/src/recipe.js';
// @ts-expect-error Plain JavaScript helper shares the distributable CLI runtime boundary.
import {sessionCookies} from '../../scripts/creative-studio-browser-upload.mjs';

const dirs:string[]=[];
async function temp(){const path=await mkdtemp(join(tmpdir(),'studio-pilot-'));dirs.push(path);return path;}
afterEach(async()=>{vi.unstubAllGlobals();for(const path of dirs.splice(0))await rm(path,{recursive:true,force:true});});
const hash=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const response=(data:any,status=200)=>new Response(JSON.stringify({data}),{status,headers:{'Content-Type':'application/json'}});
function store(){return{state:{intents:{},products:{}} as any,save:vi.fn(async()=>{})};}
const origin='https://studio.example';
const signed='https://'+'a'.repeat(32)+'.r2.cloudflarestorage.com/bucket/staging/file?X-Amz-Signature=fixture';

async function inputFixture(){const directory=await temp(),key='test-product',assetId='asset-one',bytes=Buffer.from('fixture authorized media');await mkdir(join(directory,key,'assets'),{recursive:true});await writeFile(join(directory,key,'assets',assetId),bytes);
  const recipe={id:'original-recipe',recipe_version:1,language:'es-MX',offer_version:1,content:{product_name:'Approved product',ad_copy:{primary_text:'Precio $97 MXN'},source_ids:['source-original']},assets:[{asset_id:assetId,sha256:hash(bytes),bytes:bytes.length,media_type:'audio/mpeg'}],voice:{mode:'supplied',asset:{asset_id:assetId,sha256:hash(bytes),bytes:bytes.length,media_type:'audio/mpeg'},transcript:'Palabras exactas',alignment_sha256:hash('alignment'),alignment_source:{source_id:'source-original',sha256:hash('source'),locator:'original alignment'}},captions:{words:[{text:'Palabras',startFrame:0,endFrame:19,chunkId:'c1'},{text:'exactas',startFrame:20,endFrame:50,chunkId:'c1'}]},sources:[{source_id:'source-original',sha256:hash('source'),locator:'original source'}],scenes:[{asset_id:assetId,source_ids:['source-original']}],claims:[{text:'Approved claim',source_ids:['source-original']}]};
  const sha=digest(recipe),plan={recipe,input_approval:{status:'APPROVED',recipe_sha256:sha},asset_attestations:[{asset_id:assetId,sha256:hash(bytes),permission:'ALLOWED',source_reference:'Authorized supplied narration'}]},receipt={recipe_sha256:sha,authority:'DELEGATED_PILOT',originals_modified:false};const planText=JSON.stringify(plan),receiptText=JSON.stringify(receipt);await writeFile(join(directory,key,'recipe.json'),JSON.stringify(recipe));await writeFile(join(directory,key,'plan.json'),planText);await writeFile(join(directory,key,'import-receipt.json'),receiptText);return{directory,key,recipe,profile:{key,slug:key,media_count:1,recipe_sha256:sha,plan_sha256:hash(planText),receipt_sha256:hash(receiptText)}};
}

describe('published creative pilot preparation',()=>{
  it('defaults to prepare and never accepts provider, campaign, review or credential routes',()=>{expect(parseArgs(['--inputs','/private/inputs']).execute).toBe(false);for(const path of ['/v1/studio/artifacts/'+randomUUID()+'/review','/v1/creative/settings/elevenlabs','/v1/products/'+randomUUID()+'/publish','/v1/messages'])expect(()=>studioRoute(path,'POST')).toThrow('PILOT_ROUTE_NOT_ALLOWED');expect(()=>studioRoute('/v1/studio/assets?token=secret','GET')).toThrow('PILOT_QUERY_NOT_ALLOWED');});
  it('uses exactly the engine canonical SHA including Unicode/key ordering',()=>{const input={z:'Español',a:{z:2,A:'hola',á:'otra'},array:[{b:2,a:1}],omitted:undefined};expect(digest(input)).toBe(sha256Value(input));expect(JSON.parse(canonicalJson(input))).not.toHaveProperty('omitted');});
  it('selects only recipe references, preserves actual hashes, writes private provenance, and makes no network request',async()=>{const f=await inputFixture();await writeFile(join(f.directory,f.key,'assets','unapproved-orphan'),'Must never import');const network=vi.fn(()=>{throw new Error('network forbidden');});vi.stubGlobal('fetch',network);const prepared=await prepareInputs(f.directory,[f.profile]);expect(prepared.media_count).toBe(1);expect(prepared.products[0].media.map((a:any)=>a.original_id)).toEqual(['asset-one']);const stateDir=await temp(),journal=await openJournal({origin,stateDir},prepared);try{await journal.save();expect(hash(await readFile(prepared.products[0].metadata.path))).toBe(prepared.products[0].metadata.sha256);expect(prepared.products[0].provenance.original_recipe).toEqual(f.recipe);}finally{await journal.release();}expect(network).not.toHaveBeenCalled();});
  it('rejects changed approved media and symlinks instead of finding substitute assets',async()=>{const f=await inputFixture(),path=join(f.directory,f.key,'assets','asset-one');await writeFile(path,'changed');await expect(prepareInputs(f.directory,[f.profile])).rejects.toThrow('SELECTED_ASSET_HASH_OR_RIGHTS_MISMATCH');await rm(path);await symlink(join(f.directory,f.key,'recipe.json'),path);await expect(prepareInputs(f.directory,[f.profile])).rejects.toThrow('UNSAFE_INPUT_PATH');});
  it('rejects journal reuse for a different origin or source manifest',async()=>{const f=await inputFixture(),prepared=await prepareInputs(f.directory,[f.profile]),stateDir=await temp();const initial=await openJournal({origin,stateDir},prepared);await initial.save();await initial.release();await expect(openJournal({origin:'https://different.example',stateDir},prepared)).rejects.toThrow('JOURNAL_INPUT_OR_ORIGIN_CONFLICT');prepared.products[0].metadata.sha256=hash('changed');await expect(openJournal({origin,stateDir},prepared)).rejects.toThrow('JOURNAL_INPUT_OR_ORIGIN_CONFLICT');});
  it('remaps identities while retaining every approved word, timestamp, claim, and copy field',async()=>{const f=await inputFixture(),sourceId=randomUUID(),assetId=randomUUID(),result=remapRecipe(f.recipe,{product_id:randomUUID(),offer_id:randomUUID(),offer_version:4,source_id:sourceId,source_sha256:hash('real provenance JSON'),assets:{'asset-one':assetId}});expect(result.captions).toEqual(f.recipe.captions);expect(result.voice.transcript).toBe(f.recipe.voice.transcript);expect(result.voice.alignment_sha256).toBe(f.recipe.voice.alignment_sha256);expect(result.content.ad_copy).toEqual(f.recipe.content.ad_copy);expect(result.claims[0].text).toBe(f.recipe.claims[0].text);expect(result.voice.asset.asset_id).toBe(assetId);expect(result.sources[0].source_id).toBe(sourceId);expect(result.voice.alignment_source.source_id).toBe(sourceId);expect(result).not.toHaveProperty('input_approval');expect(()=>remapRecipe(f.recipe,{product_id:randomUUID(),offer_id:randomUUID(),offer_version:1,source_id:sourceId,assets:{'asset-one':'local-file.mp3'}})).toThrow('DURABLE_ASSET_UUID_REQUIRED');});
});

describe('durable API and R2 recovery',()=>{
  it('retries transport-unknown creation with its original key and exact body, then returns its confirmed receipt',async()=>{const journal=store(),calls:any[]=[];let unknown=true;const client=createStudioClient({origin},journal,{Cookie:'private-session'},{fetcher:async(url:string,init:any)=>{calls.push({url,...init});if(unknown){unknown=false;throw new Error('response lost after commit');}return response({id:randomUUID()});}});const body={name:'Approved'};await expect(client.mutation('product:one','/v1/products',body)).rejects.toThrow('API_TRANSPORT_UNKNOWN');const created=await client.mutation('product:one','/v1/products',body);expect(await client.mutation('product:one','/v1/products',body)).toEqual(created);expect(calls).toHaveLength(2);expect(calls[0].headers['Idempotency-Key']).toBe(calls[1].headers['Idempotency-Key']);expect(calls[0].body).toBe(calls[1].body);expect(JSON.stringify(journal.state)).not.toContain('private-session');await expect(client.mutation('product:one','/v1/products',{name:'Changed'})).rejects.toThrow('PILOT_INTENT_CONFLICT');});
  it('reconciles lost completion without reserving or putting a second object',async()=>{const journal=store(),product={project_id:randomUUID()},uploadId=randomUUID(),assetId=randomUUID(),bytes=Buffer.from('media bytes'),asset={original_id:'asset-one',path:'/private/input',name:'asset-one',size_bytes:bytes.length,sha256:hash(bytes),content_type:'audio/mpeg',rights:{status:'LICENSED',evidence:'fixture'}};let serverStatus='UPLOADING';const client={mutation:vi.fn(async()=>({id:uploadId,asset_id:assetId})),fetcher:vi.fn(async()=>new Response(null,{status:200})),request:vi.fn(async(path:string)=>{if(path.endsWith('/complete')){serverStatus='VERIFYING';throw Object.assign(new Error('API_TRANSPORT_UNKNOWN'),{code:'API_TRANSPORT_UNKNOWN'});}if(path.endsWith('/reconcile')){serverStatus='READY';return{status:'READY',version:5};}if(path.includes('/parts/'))return{url:signed,size_bytes:bytes.length};return{id:uploadId,asset_id:assetId,project_id:product.project_id,status:serverStatus,version:1,sha256:asset.sha256,size_bytes:bytes.length,part_size:bytes.length,part_count:1};})};const readPart=vi.fn(async()=>bytes);await expect(uploadAsset(client,journal,product,asset,{readPart})).rejects.toThrow('API_TRANSPORT_UNKNOWN');expect(await uploadAsset(client,journal,product,asset,{readPart})).toBe(assetId);expect(client.mutation).toHaveBeenCalledTimes(1);expect(client.fetcher).toHaveBeenCalledTimes(1);expect(readPart).toHaveBeenCalledTimes(1);expect(JSON.stringify(journal.state)).not.toContain('X-Amz-Signature');});
  it('gets a fresh URL after expiry and repeats only the unconfirmed part',async()=>{const journal=store(),product={project_id:randomUUID()},bytes=Buffer.from('media bytes'),asset={original_id:'asset',size_bytes:bytes.length,sha256:hash(bytes)},uploadId=randomUUID();let puts=0;const client={mutation:vi.fn(async()=>({id:uploadId,asset_id:randomUUID()})),fetcher:vi.fn(async()=>new Response(null,{status:++puts===1?403:200})),request:vi.fn(async(path:string)=>path.includes('/parts/')?{url:signed,size_bytes:bytes.length}:path.endsWith('/complete')?{status:'READY'}:{project_id:product.project_id,status:'UPLOADING',version:1,sha256:asset.sha256,size_bytes:bytes.length,part_size:bytes.length,part_count:1})};await expect(uploadAsset(client,journal,product,asset,{readPart:async()=>bytes})).rejects.toThrow('R2_PART_URL_EXPIRED');await uploadAsset(client,journal,product,asset,{readPart:async()=>bytes});expect(client.mutation).toHaveBeenCalledTimes(1);expect(client.request.mock.calls.filter(([path])=>path.includes('/parts/'))).toHaveLength(2);});
});

describe('published output evidence',()=>{
  const qa=()=>({status:'PASS',checks:QA_CODES.map((code:string)=>({code,passed:true,actual:code==='EXPORTED_AUDIO_ALIGNMENT'?{method:'reference-output-waveform-pearson-prominence-1000hz-v1'}:{}}))});
  it('requires current 12-check QA and the exact job/recipe/attempt/device provenance',()=>{const p={job_id:randomUUID(),recipe_sha256:hash('recipe'),recipe_version:1,device_id:randomUUID()},attempt=randomUUID(),job={id:p.job_id,recipe_sha:p.recipe_sha256,recipe_version:1,status:'REVIEW',attempts:[{id:attempt,device_id:p.device_id,status:'COMPLETED'}]},outputs=['master','preview','captions','copy','manifest'].map(kind=>({job_id:p.job_id,attempt_id:attempt,kind,qa:qa(),manifest:{recipe_sha256:p.recipe_sha256,recipe_version:1}}));expect(validateArtifacts(job,outputs,p)).toHaveLength(5);expect(()=>validateQa({...qa(),checks:qa().checks.slice(0,11)})).toThrow('CURRENT_QA_12_REQUIRED');outputs[0].attempt_id=randomUUID();expect(()=>validateArtifacts(job,outputs,p)).toThrow('PILOT_OUTPUT_PROVENANCE_MISMATCH');});
  it('verifies JSON bytes without a HEAD length and still rejects oversized or truncated streams',async()=>{
    const directory=await temp(),bytes=Buffer.from('{"source":"authorized"}'),id=randomUUID();let body=bytes;
    const client={request:vi.fn(async()=>({url:signed,head_url:signed+'&method=HEAD',sha256:hash(bytes),size_bytes:bytes.length})),fetcher:vi.fn(async(_url:string,init:any)=>{expect(init.headers['Accept-Encoding']).toBe('identity');return init.method==='HEAD'?new Response(null):new Response(body);})};
    const expected={sha256:hash(bytes),size_bytes:bytes.length},target=join(directory,'provenance.json');
    await downloadVerified(client,id,target,expected);expect(await readFile(target)).toEqual(bytes);
    body=Buffer.concat([bytes,Buffer.from('extra')]);await expect(downloadVerified(client,id,join(directory,'oversized.json'),expected)).rejects.toThrow('OUTPUT_BODY_TOO_LARGE');
    body=bytes.subarray(0,-1);await expect(downloadVerified(client,id,join(directory,'truncated.json'),expected)).rejects.toThrow('OUTPUT_BYTES_MISMATCH');
    client.fetcher.mockImplementation(async()=>new Response(null,{headers:{'Content-Length':'1'}}));await expect(downloadVerified(client,id,join(directory,'false-length.json'),expected)).rejects.toThrow('OUTPUT_HEAD_MISMATCH');
  });
  it('uses a distinct HEAD signature and rejects downloaded bytes with a false advertised hash',async()=>{const directory=await temp(),bytes=Buffer.from('actual remote output'),id=randomUUID(),headUrl=signed+'&method=HEAD',client={request:vi.fn(async()=>({url:signed,head_url:headUrl,sha256:hash(bytes),size_bytes:bytes.length})),fetcher:vi.fn(async(_url:string,init:any)=>init.method==='HEAD'?new Response(null,{headers:{'Content-Length':String(bytes.length)}}):new Response(bytes))};const target=join(directory,'master.mp4');await downloadVerified(client,id,target,{sha256:hash(bytes),size_bytes:bytes.length});expect(await readFile(target)).toEqual(bytes);expect(client.fetcher.mock.calls[0][0]).toBe(headUrl);client.fetcher.mockImplementation(async(_url:string,init:any)=>init.method==='HEAD'?new Response(null,{headers:{'Content-Length':String(bytes.length)}}):new Response(Buffer.alloc(bytes.length,1)));await expect(downloadVerified(client,id,join(directory,'bad.mp4'),{sha256:hash(bytes),size_bytes:bytes.length})).rejects.toThrow('OUTPUT_BYTES_MISMATCH');});
});


describe('explicit preferred Windows offline queue',()=>{
  const project=randomUUID(),now=Date.parse('2026-09-08T17:00:00.000Z');
  const device=(platform='win32-x64',lastSeen:string|null=null)=>({id:randomUUID(),platform,status:'CONNECTED',project_ids:[project],last_seen_at:lastSeen});
  it('does not infer a heartbeat from null, invalid, stale or future timestamps',()=>{
    expect(parseArgs(['--inputs','/private/inputs']).allowOfflineWindows).toBe(false);
    expect(parseArgs(['--inputs','/private/inputs','--allow-offline-windows']).allowOfflineWindows).toBe(true);
    for(const lastSeen of [null,'invalid','2026-09-08T16:58:29Z','2026-09-08T17:01:00Z'])expect(()=>validatePreferredWorker(device('win32-x64',lastSeen),project,{now})).toThrow('WORKER_NOT_CONNECTED_OR_SCOPED');
    expect(validatePreferredWorker(device('darwin-arm64','2026-09-08T16:59:30Z'),project,{now})).toMatchObject({online:true,offline_windows_authorized:false,waiting_for_preferred_worker:false});
  });
  it('allows only the explicit approved Windows scope without altering its observed connection',()=>{
    const selected=device(),original=structuredClone(selected);
    expect(validatePreferredWorker(selected,project,{allowOfflineWindows:true,now})).toMatchObject({status:'CONNECTED',last_seen_at:null,online:false,offline_windows_authorized:true,waiting_for_preferred_worker:true});
    expect(selected).toEqual(original);
    for(const d of [undefined,device('darwin-arm64'),{...device(),project_ids:[randomUUID()]},{...device(),status:'REVOKED'},{...device(),status:'PAUSED'},{...device(),platform:'win32-arm64'}])expect(()=>validatePreferredWorker(d,project,{allowOfflineWindows:true,now})).toThrow('WORKER_NOT_CONNECTED_OR_SCOPED');
  });
  it('submits the selected offline Windows UUID with explicit flag and records the true waiting snapshot',async()=>{
    const selected=device(),journal=store(),recipeId=randomUUID(),recipeSha=hash('recipe');journal.state.products.oraciones={project_id:project,recipe_id:recipeId,recipe_version:1,recipe_sha256:recipeSha};
    const client={request:vi.fn(async(path:string)=>path==='/v1/creative/devices'?[selected]:{version:1,sha256:recipeSha}),mutation:vi.fn(async(name:string)=>name.startsWith('quote:')?{quote_id:randomUUID(),expires_at:new Date(Date.now()+60000).toISOString(),ready:true,estimated_cost:0,waiting_for_worker:false}:{job_id:randomUUID(),status:'QUEUED'})};
    const prepared={products:[{key:'oraciones'}]},mapping={oraciones:{device_id:selected.id}};
    await expect(submitPilot(client,journal,prepared,mapping,'oraciones')).rejects.toThrow('WORKER_NOT_CONNECTED_OR_SCOPED');
    expect(client.mutation).not.toHaveBeenCalled();
    await submitPilot(client,journal,prepared,mapping,'oraciones',{allowOfflineWindows:true});
    expect(client.mutation.mock.calls[1]).toMatchObject(['submit:oraciones','/v1/studio/recipes/'+recipeId+'/submit',{preferred_device_id:selected.id,max_cost:0}]);
    expect(journal.state.products.oraciones.worker_snapshot).toMatchObject({online:false,last_seen_at:null,waiting_for_preferred_worker:true,offline_windows_authorized:true});
    expect(journal.state.products.oraciones.quote.waiting_for_worker).toBe(false);
    expect(journal.state.products.oraciones.job_id).toBeTruthy();
  });
});


describe('explicit browser-first media transport',()=>{
  it('defaults to no browser and pins exactly the first selected media across resume',()=>{
    expect(parseArgs(['--inputs','/private/inputs']).browserFirstUpload).toBe(false);
    expect(parseArgs(['--inputs','/private/inputs','--browser-first-upload']).execute).toBe(false);
    const journal=store(),prepared={products:[{key:'mi-ciclo-listo',media:[{original_id:'selected-first',sha256:hash('first'),size_bytes:5},{original_id:'selected-second',sha256:hash('second'),size_bytes:6}]},{key:'oraciones',media:[{original_id:'other-product',sha256:hash('third'),size_bytes:7}]}]};
    expect(browserFirstSelection(journal,prepared,false)).toBeNull();expect(journal.state.browser_first_upload).toBeUndefined();
    expect(browserFirstSelection(journal,prepared,true)).toMatchObject({product_key:'mi-ciclo-listo',original_asset_id:'selected-first'});
    expect(()=>browserFirstSelection(journal,prepared,false)).toThrow('BROWSER_UPLOAD_SELECTION_CHANGED');
    prepared.products[0].media.reverse();expect(()=>browserFirstSelection(journal,prepared,true)).toThrow('BROWSER_UPLOAD_SELECTION_CHANGED');
    const old=store();old.state.products['mi-ciclo-listo']={uploads:{'selected-second':{transport:'NODE_FETCH',parts:{}}}};
    expect(()=>browserFirstSelection(old,prepared,true)).toThrow('BROWSER_UPLOAD_ALREADY_USED_NODE');
  });
  it('uses the browser for the actual part bytes and preserves evidence without presigned URL or cookies',async()=>{
    const journal=store(),product={project_id:randomUUID()},bytes=Buffer.from('actual fixture media'),asset={original_id:'asset',size_bytes:bytes.length,sha256:hash(bytes)},uploadId=randomUUID();
    const client={mutation:vi.fn(async()=>({id:uploadId,asset_id:randomUUID()})),fetcher:vi.fn(async()=>{throw new Error('Node transport forbidden for this selected asset');}),request:vi.fn(async(path:string)=>path.includes('/parts/')?{url:signed,size_bytes:bytes.length}:path.endsWith('/complete')?{status:'READY'}:{project_id:product.project_id,status:'UPLOADING',version:1,sha256:asset.sha256,size_bytes:bytes.length,part_size:bytes.length,part_count:1})};
    const transport={kind:'BROWSER_CHROMIUM',evidence:{transport:'BROWSER_CHROMIUM',origin,browser_version:'fixture',csp_sha256:hash('policy'),csp_bypass:false,tls_verification:true},put:vi.fn(async(url:string,b:Buffer)=>({ok:true,status:200,sha256:hash(b),bytes:b.length}))};
    await uploadAsset(client,journal,product,asset,{transport,readPart:async()=>bytes});
    expect(transport.put).toHaveBeenCalledWith(signed,bytes);expect(client.fetcher).not.toHaveBeenCalled();
    const saved=(product as any).uploads.asset;expect(saved.status).toBe('READY');expect(saved.parts[1]).toMatchObject({transport:'BROWSER_CHROMIUM',sha256:hash(bytes),bytes:bytes.length,http_status:200});
    expect(JSON.stringify(journal.state)).not.toContain('X-Amz-Signature');expect(JSON.stringify(saved)).not.toContain('X-Amz-Signature');
    await expect(uploadAsset(client,journal,product,asset,{readPart:async()=>bytes})).rejects.toThrow('UPLOAD_TRANSPORT_CHANGED');
  });
  it('confirms the browser uploaded UUID/SHA is actually referenced by the immutable recipe',()=>{
    const journal=store(),assetId=randomUUID(),recipeId=randomUUID(),sha256=hash('media');journal.state.browser_first_upload={product_key:'mi-ciclo-listo',status:'READY',asset_id:assetId,sha256};
    const recipe={id:recipeId,sha256:hash('recipe'),version:1,recipe:{assets:[{asset_id:assetId,sha256}],scenes:[{asset_id:assetId}],voice:{asset:{asset_id:randomUUID()}}}};
    verifyBrowserInputRecipe(journal,{key:'mi-ciclo-listo'},recipe);expect(journal.state.browser_first_upload).toMatchObject({recipe_id:recipeId,recipe_sha256:recipe.sha256,recipe_usage_confirmed:true});
    recipe.recipe.scenes=[];expect(()=>verifyBrowserInputRecipe(journal,{key:'mi-ciclo-listo'},recipe)).toThrow('BROWSER_INPUT_NOT_USED_BY_RECIPE');
  });
  it('creates only secure ephemeral cookies and rejects missing/non-HTTPS browser sessions',()=>{
    expect(sessionCookies(origin,'__Secure-session=private-token; another=encoded%2Bvalue')).toEqual([{name:'__Secure-session',value:'private-token',url:origin,secure:true,httpOnly:true,sameSite:'Lax'},{name:'another',value:'encoded%2Bvalue',url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
    expect(()=>sessionCookies('http://studio.example','session=value')).toThrow('BROWSER_SESSION_REQUIRED');expect(()=>sessionCookies(origin,'')).toThrow('BROWSER_SESSION_REQUIRED');expect(()=>sessionCookies(origin,'invalid')).toThrow('BROWSER_SESSION_INVALID');
  });
});


describe('canonical recipe import after durable uploads',()=>{
 it('creates a titled recipe without requiring optional legacy metadata and reuses ready media',async()=>{
  const f=await inputFixture(),prepared=await prepareInputs(f.directory,[f.profile]),input=prepared.products[0],journal=store();
  const productId=randomUUID(),offerId=randomUUID(),projectId=randomUUID(),recipeId=randomUUID(),mediaId=randomUUID(),sourceId=randomUUID(),uploadMedia=randomUUID(),uploadSource=randomUUID();
  journal.state.products[f.key]={key:f.key,product_id:productId,offer_id:offerId,offer_version:1,project_id:projectId,uploads:{'asset-one':{id:uploadMedia,asset_id:mediaId,transport:'NODE_FETCH',status:'READY',parts:{1:{transport:'NODE_FETCH'}}},provenance:{id:uploadSource,asset_id:sourceId,transport:'NODE_FETCH',status:'READY',parts:{1:{transport:'NODE_FETCH'}}}}};
  let created:any;const client={fetcher:vi.fn(),request:vi.fn(async(path:string)=>{
   if(path==='/v1/products/'+productId)return{id:productId,name:input.recipe.content.product_name};
   if(path==='/v1/offers/'+offerId)return{id:offerId,product_id:productId,currency:'MXN',base_amount_minor:9700,version:1};
   if(path.endsWith('/reconcile'))return{status:'READY',version:1};
   if(path.startsWith('/v1/studio/uploads/')){const asset=path.endsWith(uploadMedia)?input.media[0]:input.metadata;return{project_id:projectId,size_bytes:asset.size_bytes,sha256:asset.sha256,status:'READY',version:1};}
   if(path==='/v1/studio/recipes/'+recipeId)return{...created,validation:{ok:true}};
   throw new Error('unexpected fixture request');
  }),mutation:vi.fn(async(name:string,_path:string,body:any)=>{if(name==='recipe:'+f.key){const recipe={...body.recipe,id:recipeId,recipe_version:1};created={id:recipeId,version:1,sha256:digest(recipe),recipe};return created;}return{id:randomUUID(),decision:'APPROVED'};})};
  await importPilot(client,journal,prepared,{});
  expect(client.mutation.mock.calls[0][2].title).toBe('Piloto V1 · Approved product');
  expect(client.mutation).toHaveBeenCalledTimes(2);expect(client.fetcher).not.toHaveBeenCalled();
  expect(created.recipe).not.toHaveProperty('legacy');expect(created.recipe.content.ad_copy).toEqual(f.recipe.content.ad_copy);
  expect(journal.state.products[f.key].status).toBe('INPUTS_READY');
 });
});
