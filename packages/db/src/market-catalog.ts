import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {marketCatalogSchema} from '../../contracts/src/market-catalog.js';
import {marketEnvironmentSchema} from '../../contracts/src/market-variant-store.js';
import {MarketStoreError,marketRecordVersionHash} from './market-variants.js';
/** Metadata projection only. Bodies stay in this function to derive precisely
 * the immutable-version hash consumed by008; no secret or body is returned. */
export async function readMarketCatalog(db:ProfileExecutor,environment:unknown,productId:unknown){
 const env=marketEnvironmentSchema.parse(environment),id=z.uuid().parse(productId).toLowerCase();
 const product=(await db.query(`SELECT r.id,r.version,r.body->>'name' AS name,
 EXISTS(SELECT 1 FROM market_families f WHERE f.workspace_id=r.workspace_id AND f.environment=r.environment AND f.id=r.id) AS adopted
 FROM records r WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='product' AND r.id=$3
 AND NOT(r.body ? 'archived_at') AND COALESCE(r.body->>'status','')<>'ARCHIVED' FOR SHARE OF r`,[db.workspaceId,env,id])).rows[0];
 if(!product)throw new MarketStoreError('MARKET_NOT_FOUND',404);
 const rows=(await db.query(`WITH offers AS (
 SELECT r.id,r.body FROM records r WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='offer'
 AND r.body->>'product_id'=$3 AND r.body->>'status'='PUBLISHED' AND NOT(r.body ? 'archived_at')
 ), refs AS (
 SELECT 'offer' AS option_kind,'offer' AS record_kind,id::text AS record_id FROM offers
 UNION SELECT 'flow','workflow',body->>'workflow_version_id' FROM offers
 UNION SELECT 'seller','agent',body->>'agent_version_id' FROM offers
 UNION SELECT 'collection','bank_profile',body->>'payment_profile_version_id' FROM offers
 UNION SELECT 'material','asset',item->>'asset_id' FROM offers
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(body->'fulfillment')='array' THEN body->'fulfillment' ELSE '[]'::jsonb END) AS item
 ) SELECT refs.option_kind,v.record_id,v.workspace_id,v.environment,v.kind,v.version,v.body
 FROM refs JOIN records r ON r.id::text=refs.record_id AND r.kind=refs.record_kind AND r.workspace_id=$1 AND r.environment=$2
 JOIN record_versions v ON v.record_id=r.id AND v.workspace_id=r.workspace_id AND v.environment=r.environment AND v.kind=r.kind AND v.version=r.version
 WHERE NOT(r.body ? 'archived_at') AND COALESCE(r.body->>'status','')<>'ARCHIVED'
 ORDER BY refs.option_kind,v.record_id LIMIT 1001 FOR SHARE OF r`,[db.workspaceId,env,id])).rows;
 if(rows.length>1000)throw new MarketStoreError('MARKET_CATALOG_TOO_LARGE',409);
 const labels={offer:'Oferta',flow:'Flujo',seller:'Vendedor',collection:'Cobro',material:'Material'};
 return marketCatalogSchema.parse({scope:{workspace_id:db.workspaceId,environment:env},product,
 options:rows.map(row=>({kind:row.option_kind,label:typeof row.body.name==='string'&&row.body.name.trim()?row.body.name.trim():labels[row.option_kind as keyof typeof labels]+' '+row.record_id,
 ref:{id:row.record_id,revision:row.version,sha256:marketRecordVersionHash(row)}}))});
}
