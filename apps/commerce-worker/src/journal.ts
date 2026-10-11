import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {atomicJson} from './config.js';
export interface LocalAttempt{jobId:string;attemptId:string;fence:number;leaseExpiresAt:string;phase:'MATERIALIZING'|'COMPUTING'|'UPLOADING'|'COMPLETE_PENDING'|'FAILED_PENDING'|'DONE'|'STALE';claim:any;outputs?:{kind:string;path:string;sha256:string;sizeBytes:number;contentType:string}[];artifacts?:string[];qa?:unknown;manifest?:unknown;error?:string;retryable?:boolean;updatedAt:string;}
export class Journal{
 readonly file:string;private pending:Promise<void>=Promise.resolve();
 constructor(root:string){this.file=path.join(root,'journal.json');}
 async read():Promise<LocalAttempt|null>{try{return JSON.parse(await readFile(this.file,'utf8'));}catch(e:any){if(e.code==='ENOENT')return null;throw Error('JOURNAL_INVALID',{cause:e});}}
 write(attempt:LocalAttempt){const clean={...attempt,updatedAt:new Date().toISOString()};this.pending=this.pending.then(()=>atomicJson(this.file,clean));return this.pending;}
}
