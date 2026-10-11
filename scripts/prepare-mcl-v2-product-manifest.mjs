import {createHash} from 'node:crypto';
import {readFile,rename,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const source=option('--source'),output=option('--output');
if(!source||!output)throw new Error('SOURCE_AND_OUTPUT_REQUIRED');
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const portalRoot=join(repoRoot,'portals','mi-ciclo-listo');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

async function localize(asset,path){
 const bytes=await readFile(path);
 if(digest(bytes)!==asset.sha256)throw new Error('PRODUCT_FILE_HASH_MISMATCH');
 return{...asset,sourcePath:path,bytes:bytes.length};
}

const historical=JSON.parse(await readFile(resolve(source),'utf8'));
const catalog=await localize(historical.catalog,join(portalRoot,'data','activities.json'));
const corePdfs=[];
for(const asset of historical.corePdfs)corePdfs.push(await localize(asset,join(portalRoot,'private','pdfs',asset.file)));
const calendarPdf=await localize(historical.calendarPdf,join(portalRoot,'private','pdfs',historical.calendarPdf.file));
const manifest={
 ...historical,
 productVersion:'mcl-sales-flow-v2-2026-09-20',
 pricingMxnCents:{referencePrice:9700,positivePaymentUnlocksAll:true,minimumUnlockAmount:1},
 portal:{...historical.portal,sourceRoot:portalRoot},
 catalog,corePdfs,calendarPdf,
 evidence:{...historical.evidence,source_manifest:resolve(source),sales_flow_audio_review:join(dirname(resolve(output)),'audio-review.json')},
 restrictions:[
  'No SEP endorsement',
  'Human pedagogical review pending',
  'This manifest authorizes no customer messaging or campaign spend',
  'A positive approved payment records the observed amount and unlocks every configured gift; no commercial threshold is encoded here',
  'Calendar is a forty-week planning route, not the official school calendar; primary revisits are explicit, not new activities',
 ],
};
const target=resolve(output),temporary=target+'.partial';
await writeFile(temporary,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});await rename(temporary,target);
console.log(JSON.stringify({status:'VERIFIED_LOCAL',output:target,productVersion:manifest.productVersion,counts:manifest.counts,positivePaymentUnlocksAll:true}));
