import type {ProfileCatalog} from './profile-inventory.js';
const columns=[['session_id','text'],['user_id','text'],['workspace_id','text'],['membership_version','integer'],['version','integer'],['updated_at','timestamp with time zone']];
const functions={
 'public.list_authenticated_profile_choices(native_session text, native_user text)':'2efd8c65cd56baddb91fe154b5c658a1ffb0f869be20fee982242bc503f5be45',
 'public.select_authenticated_profile(native_session text, native_user text, target_profile text, expected_version integer)':'88635ea12dcd79c7cb19dc37a4e3d89086a8c66f848809fafe8b484b872ac241',
};
function check(value:unknown):asserts value{if(!value)throw Error('PRIVACY_SELECTION_AUTHORITY_UNVERIFIED');}
/** A narrowly classified session selector: no JSON/content columns and no direct
 * runtime mutations.030 must revoke the old API writes before this exclusion.
 * It remains governed by native020 CAS/locks and final catalog/role fingerprints.
 */
export function verifyPrivacySelectionAuthority(catalog:ProfileCatalog):boolean{
 const table=catalog.tables.find(t=>t.name==='profile_session_context');if(!table)return false;
 check(table.columns.length===columns.length&&columns.every(([name,type],i)=>{const c=table.columns[i];return c?.name===name&&c.type===type&&c.not_null;}));
 const grants=catalog.grants.filter(g=>g.schema==='public'&&g.table===table.name&&g.grantee!==table.owner).map(g=>[g.grantee,g.privilege,g.grantable]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
 check(JSON.stringify(grants)===JSON.stringify([['commerce_api','SELECT',false],['commerce_profile_bootstrap_owner','INSERT',false],['commerce_profile_bootstrap_owner','SELECT',false],['commerce_profile_bootstrap_owner','UPDATE',false]]));
 check(!catalog.column_grants.some(g=>g.schema==='public'&&g.table===table.name));
 for(const[identity,hash]of Object.entries(functions)){
  const fn=catalog.privileged_functions.find(f=>f.identity===identity);check(fn?.definition_hash===hash&&fn.owner==='commerce_profile_bootstrap_owner'&&JSON.stringify(fn.config)==='["search_path=pg_catalog"]');
  const access=catalog.function_grants.filter(g=>g.identity===identity);check(access.length===2&&access.every(g=>g.security_definer&&!g.grantable&&g.privilege==='EXECUTE'&&['commerce_api','commerce_profile_bootstrap_owner'].includes(g.grantee))&&new Set(access.map(g=>g.grantee)).size===2);
 }
 return true;
}
