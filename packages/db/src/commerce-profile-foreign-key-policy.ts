import type {ProfileCatalog} from './profile-inventory.js';
import {commerceProfileRowPolicy} from './commerce-profile-row-policy.js';
import type {ProfileForeignKeyPolicy,ProfileForeignKeyReview,ProfileTableScope} from './profile-foreign-key-plan.js';

// Catalog39 native metadata, independently reviewed. These are edge identities,
// not arbitrary names selected by a caller or inferred from a nullable column.
const reviewedEdges:Record<string,ProfileForeignKeyReview>={
 'health_observation_index.health_observation_index_record_id_fkey':{original_sha256:'45106a62531c12986924e186d48e41106609b698a956b367e45cbc767ced2446',preserve_delete_cascade:true},
 'outbox_gate_schedule.outbox_gate_schedule_effect_id_fkey':{original_sha256:'c0066ba4887e702af03dd46bbb76970c9a6d1b157d26efe5393948cb4c21e21f',preserve_delete_cascade:true},
 'ai_attempts.number_lab_attempt_binding':{original_sha256:'41da964b97d34c09be79c50924e873c0ce6ac83003860c31aa9a0dcd5eff2503',target_scope:{workspace:'workspace_id',environment:'budget_environment'}},
 'commerce_number_lab.ai_bindings.ai_bindings_workspace_id_budget_environment_grant_id_fkey':{original_sha256:'57261f285c2074d30bf05aed4b20045bcc607be6bbca39bc5ffecdd5b62180bf',source_scope:{workspace:'workspace_id',environment:'budget_environment'}},
 'commerce_number_lab.run_releases.run_releases_workspace_id_source_environment_release_id_fkey':{original_sha256:'0eab86a5d9efb0799fc4e9032b21ccf27d5058ae7341440e410c9430b1145a5d',source_scope:{workspace:'workspace_id',environment:'source_environment'}},
 'commerce_number_lab.run_releases.run_releases_workspace_id_source_environment_variant_id_fkey':{original_sha256:'cabf8a4887b95baf463c37ed913cf65206ac1f7e582620a5e42b55628de5d51c',source_scope:{workspace:'workspace_id',environment:'source_environment'}}
};
const globalTables=new Set(['platform_admins','platform_backup_runs','platform_tokens','privacy_reference_epoch','privacy_reference_leases','profile_cutover_historical_tables','account','identity_audit','identity_mail_jobs','identity_mail_settings','identity_rate_limits','identity_reset_links','session','user','verification','schema_migrations','ai_model_prices','profile_quota_policy','profile_quota_load_admissions']);
// V7 F2 closed components with a NOT NULL text environment dimension.
const componentEnvironmentTables=new Set(['ai_profile_preferences','financial_retention_attestations','financial_retention_corrections','financial_retention_installations','privacy_asset_apply_admissions','privacy_asset_batches','privacy_asset_completions','privacy_backup_file_sets','privacy_backup_row_entries','privacy_backup_row_pages','privacy_backup_row_seals','privacy_backup_row_sets','privacy_minimized_assets','privacy_minimized_records','privacy_opaque_passes','privacy_record_apply_admissions','privacy_record_batches','privacy_record_completions','privacy_result_seals']);
const componentProfileTables=new Set(['meta_profile_credential_versions','meta_profile_credentials','profile_onboarding','privacy_backup_attestations','privacy_backup_revocations','privacy_hold_events','privacy_jobs','privacy_opaque_implementations','privacy_policy_adoptions','privacy_result_confirmations','privacy_result_preservations','profile_adoption_quarantine','profile_adoption_receipts','profile_role_adoptions']);
const privateTables=new Set(['commerce_number_lab.runs','commerce_number_lab.operations','commerce_number_lab.events','commerce_number_lab.run_releases','commerce_number_lab.ai_bindings']);
/** Whole-catalog classification through030. It prepares FK additions only;
 * it does not adopt data, authorize execution or certify global ACL/RLS. */
export function commerceProfileForeignKeyPolicy(catalog:ProfileCatalog):ProfileForeignKeyPolicy{
 const rowPolicy=commerceProfileRowPolicy(catalog),tables:Record<string,ProfileTableScope>={};
 for(const [key,scope]of Object.entries(rowPolicy.tables)){
  if(scope.mode==='scope'){tables[key]={workspace:scope.workspace,environment:scope.environment};continue;}
  if(globalTables.has(key)){tables[key]=null;continue;}
  if(key==='manual_controls'){tables[key]={workspace:'workspace_id',environment:'environment',nullable_columns:['environment']};continue;}
  if(key==='creative_pairings'){tables[key]={workspace:'workspace_id',environment:null,nullable_columns:['workspace_id']};continue;}
  if(key==='privacy_writer_epochs'||key==='privacy_writer_leases'||key==='creative_devices'||key==='profile_quota_coverage'||key==='profile_quota_entries'||privateTables.has(key)){tables[key]={workspace:'workspace_id',environment:null};continue;}
  if(componentEnvironmentTables.has(key)){tables[key]={workspace:'workspace_id',environment:'environment'};continue;}
  if(componentProfileTables.has(key)){tables[key]={workspace:'workspace_id',environment:null};continue;}
  if(key==='platform_operations'){tables[key]={workspace:'profile_id',environment:null};continue;}
  throw Error('COMMERCE_FK_RELATION_UNCLASSIFIED');
 }
 // Retired unbound pairings are never a parent/child business authority. Their
 // nullable workspace is preserved only as history with no native FK edges.
 if([...catalog.foreign_keys,...(catalog.non_public_foreign_keys??[])].some(f=>f.table==='creative_pairings'||(f.referenced_schema==='public'&&f.referenced_table==='creative_pairings')))throw Error('COMMERCE_FK_RETIRED_PAIRING_EDGE');
 return{schema_version:1,tables,reviewed_edges:structuredClone(reviewedEdges)};
}
