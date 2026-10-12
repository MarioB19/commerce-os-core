import type {DomainRecord} from '../../contracts/src/index.js';
import {profileCatalogResources,profileCatalogIdSchema,profileCatalogListSchema,
 profileCatalogDetailQuerySchema,profileCatalogVersionsQuerySchema,
 type ProfileCatalogKind,type ProfileCatalogList,type ProfileCatalogVersions} from '../../contracts/src/profile-catalog.js';
import {requireProfileId,type ProfileExecutor} from './profile-context.js';

function context(db:ProfileExecutor,kind:ProfileCatalogKind){
 requireProfileId(db.workspaceId);
 if(!Object.values(profileCatalogResources).some(row=>row.kind===kind))throw new Error('PROFILE_CATALOG_KIND_INVALID');
}
export class ProfileCatalogNotFound extends Error{
 readonly code='NOT_FOUND';readonly statusCode=404;
 constructor(){super('NOT_FOUND');}
}
/** Only the already-authorized transaction executor enters this repository. */
export async function listProfileCatalog(db:ProfileExecutor,kind:ProfileCatalogKind,input:ProfileCatalogList){
 context(db,kind);const q=profileCatalogListSchema.parse(input);
 const rows=(await db.query<DomainRecord>(`SELECT id,workspace_id,environment,kind,version,body,created_at,updated_at
 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind=$3
 AND ($4::boolean OR (COALESCE(body->>'archived_at','')='' AND COALESCE(body->>'status','')<>'ARCHIVED'))
 AND ($5::text IS NULL OR body->>'status'=$5)
 AND ($6::text IS NULL OR strpos(lower(COALESCE(body->>'name','')||' '||COALESCE(body->>'description','')),lower($6))>0)
 ORDER BY created_at DESC,id DESC LIMIT $7 OFFSET $8`,
 [db.workspaceId,q.environment,kind,q.include_archived==='true',q.status??null,q.q??null,q.limit+1,q.offset])).rows;
 return{records:rows.slice(0,q.limit),hasMore:rows.length>q.limit};
}
export async function readProfileCatalog(db:ProfileExecutor,kind:ProfileCatalogKind,id:string,environment:'REAL'|'SIMULATION'){
 context(db,kind);profileCatalogIdSchema.parse({id});profileCatalogDetailQuerySchema.parse({environment});
 const row=(await db.query<DomainRecord>(`SELECT id,workspace_id,environment,kind,version,body,created_at,updated_at
 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind=$3 AND id=$4`,[db.workspaceId,environment,kind,id])).rows[0];
 if(!row)throw new ProfileCatalogNotFound();return row;
}
export async function listProfileCatalogVersions(db:ProfileExecutor,kind:ProfileCatalogKind,id:string,input:ProfileCatalogVersions){
 context(db,kind);const q=profileCatalogVersionsQuerySchema.parse(input);profileCatalogIdSchema.parse({id});
 // A missing/foreign parent must be indistinguishable, even when old rows exist.
 await readProfileCatalog(db,kind,id,q.environment);
 const rows=(await db.query<DomainRecord>(`SELECT v.record_id AS id,v.workspace_id,v.environment,v.kind,v.version,v.body,v.created_at,v.created_at AS updated_at
 FROM record_versions v JOIN records r ON r.id=v.record_id AND r.workspace_id=v.workspace_id
 AND r.environment=v.environment AND r.kind=v.kind
 WHERE v.workspace_id=$1 AND v.environment=$2 AND v.kind=$3 AND v.record_id=$4
 AND ($5::integer IS NULL OR v.version<$5) ORDER BY v.version DESC LIMIT $6`,
 [db.workspaceId,q.environment,kind,id,q.before??null,q.limit+1])).rows;
 return{records:rows.slice(0,q.limit),hasMore:rows.length>q.limit};
}
