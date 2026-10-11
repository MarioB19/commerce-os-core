export const dynamic='force-dynamic';
export function GET(){return Response.json({product:'Mi Ciclo Listo',content_profile:'synthetic-public-v1',release:process.env.MCL_RELEASE_SHA??'local',activities:480,grades:9,core_pdfs:9,calendar_in_portal:false},{headers:{'Cache-Control':'no-store'}});}
