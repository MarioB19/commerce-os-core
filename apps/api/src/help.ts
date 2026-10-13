import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {helpSections,helpMarkdown,HELP_VERSION} from '../../../packages/contracts/src/help.js';

/** V7 F7 (RF-16.d): the same help as the application, for API and MCP, and as
 * one Markdown download. Requires a profile session or personal token like
 * every other /v2 read; the content holds no profile data. */
export async function helpRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 const q=z.object({section:z.string().regex(/^[a-z-]{2,40}$/).optional(),environment:z.literal('REAL').optional()}).strict();
 app.get('/v2/help',async(req,reply)=>{const {section}=q.parse(req.query??{});reply.header('Cache-Control','no-store');
  return{data:await withProfileRequest(req,'REAL',{scope:'help:read',mutation:false},async()=>{
   if(!section)return{version:HELP_VERSION,sections:helpSections.map(({id,title,summary})=>({id,title,summary}))};
   const found=helpSections.find(s=>s.id===section);if(!found)throw Object.assign(new Error('HELP_SECTION_NOT_FOUND'),{statusCode:404,code:'HELP_SECTION_NOT_FOUND',publicMessage:'No existe esa sección de ayuda.'});
   return{version:HELP_VERSION,section:found};},deps)};});
 app.get('/v2/help/download',async(req,reply)=>{q.parse(req.query??{});
  await withProfileRequest(req,'REAL',{scope:'help:read',mutation:false},async()=>null,deps);
  return reply.header('Cache-Control','no-store').header('Content-Type','text/markdown; charset=utf-8')
   .header('Content-Disposition',`attachment; filename="ayuda-commerce-os-${HELP_VERSION}.md"`).send(helpMarkdown());});
}
