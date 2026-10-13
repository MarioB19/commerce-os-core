import type {FastifyInstance} from 'fastify';
import {fail} from './context.js';
/** V7 F8 retirement contract: the creative device gateway and the studio API
 * answer 410 with a stable code (the installer's routing check relies on it).
 * Hidden from OpenAPI: they are not operations. Every other retired module
 * (Inteligencia, SearchAPI, R2 library, assistant, simulators) has no route. */
export async function retiredRoutes(app:FastifyInstance){
 app.all('/creative-device/*',{schema:{hide:true}},async()=>{throw fail(410,'PLATFORM_PRODUCTION_RETIRED');});
 app.all('/v1/studio/*',{schema:{hide:true}},async()=>{throw fail(410,'PLATFORM_PRODUCTION_RETIRED','El estudio creativo se retiró.');});
}
