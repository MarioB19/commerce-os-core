import type {ProfileCatalog} from './profile-inventory.js';
import type {ProfileRowIsolationPolicy,ProfileRowScope} from './profile-row-isolation-plan.js';
import {V7_RETIRED_TABLES} from './retired-tables.js';

// Explicit reviewed application roles. ACLs remain the source of SQL privileges;
// membership in this list grants nothing and does not include closed-port owners.
const applicationRoles=['commerce_api','commerce_ingress','commerce_automation','commerce_channel','commerce_maintenance','commerce_ai','commerce_number_lab','commerce_results','commerce_mail_dispatch'];
// Fixed table identities, not names selected from columns or observed grants.
const environmentTables=[
 'ai_admission_denials','ai_attempt_allocations','ai_attempt_events','ai_attempts',
 'ai_budget_periods','ai_credential_operations','ai_credential_versions','ai_credentials',
 'ai_key_budgets','ai_runtime_grants','campaign_products','channel_session_events',
 'channel_sessions','commands','commercial_assignment_history','commercial_assignments',
 'commercial_buyer_exclusions','commercial_resolution_receipts','commercial_remarketing_attempts','commercial_remarketing_cycles','consumer_receipts',
 'continuous_authorization_events','continuous_authorization_operations','continuous_authorizations','copy_source_isolation_challenges',
 'creative_artifacts','creative_assets','creative_attempts','creative_batch_versions',
 'creative_batches','creative_budgets','creative_conformities','creative_jobs',
 'creative_playbook_receipts','creative_projects','creative_provider_operations','creative_quotes',
 'creative_recipe_intakes','creative_recipe_versions','creative_recipes','creative_reviews',
 'creative_settings','creative_steps','creative_storage_usage','creative_uploads',
 'creative_voice_brief_versions','creative_voice_briefs','creative_voice_operations','domain_events',
 'effect_attempts','finished_asset_intakes','health_observation_index','idempotency',
 'inbound_envelopes','integration_diagnostics','integration_secrets','integration_setting_versions',
 'integration_settings','intelligence_analyses','intelligence_analysis_batches','intelligence_corpus_evaluations',
 'intelligence_observations','intelligence_offers','intelligence_opportunities','intelligence_runs',
 'intelligence_searches','market_families','market_journey_snapshots','market_operations',
 'market_releases','market_variant_events','market_variants','mcl_sponsorships',
 'mcl_test_scopes','meta_ad_metadata','meta_insight_accounts','meta_insight_coverage',
 'meta_insight_days','meta_insight_jobs','meta_links','meta_syncs',
 'number_capacity_observations','number_capacity_slots','number_dispatch_slots','number_link_access',
 'number_operations','number_simulation_groups','operation_authorizations','operational_alerts',
 'operational_evidence','operational_settings','outbox','outbox_gate_schedule',
 'ownership_isolation_receipts','payment_contributions','physical_chats','platform_retirement_ledger',
 'privacy_closure_receipts','product_assistant_proposals','provider_diagnostics','receipt_order_policy_snapshots',
 'receipt_policy_heads','receipt_policy_operations','receipt_policy_versions','record_versions',
 'records','reported_sales','result_financial_context','result_goal_events',
 'result_goal_operations','result_goals','result_metric_daily','result_metric_sealed',
 'result_projection_sources','result_projection_state','result_rebuild_receipts','retention_files',
 'retention_plans','retention_policies','retention_tombstones','sales_command_proposals',
 'sales_history_imports','session_ownership','timers','warmup_account_reservations',
 'warmup_content','warmup_content_usage','warmup_continuity_adoptions','warmup_conversations',
 'warmup_day_credits','warmup_effect_origins','warmup_episodes','warmup_group_events',
 'warmup_group_receipts','warmup_groups','warmup_identities','warmup_library_drafts',
 'warmup_manual_declarations','warmup_observations','warmup_plans','warmup_pools',
 'warmup_profiles','warmup_programs','warmup_rate_buckets','warmup_rate_reservations',
 'warmup_schedule_runs','warmup_simulated_events','warmup_simulation_runs','warmup_states',
 'warmup_turns'
];
const sharedProfileTables=[
 'creative_global_budgets','creative_members','integration_imports','memberships',
 'personal_access_tokens','profile_invitation_mail_attempts','profile_invitation_mail_jobs','profile_invitations',
 'profile_personal_token_routes','profile_session_context','profile_token_operations','service_tokens'
];
const globalIdentityTables=[
 'account','identity_audit','identity_mail_jobs','identity_mail_settings',
 'identity_rate_limits','identity_reset_links','session','user',
 'verification'
];
const privateLaboratoryTables=['commerce_number_lab.runs','commerce_number_lab.operations','commerce_number_lab.events','commerce_number_lab.run_releases','commerce_number_lab.ai_bindings'];
const quotaTables=['profile_quota_policy','profile_quota_load_admissions','profile_quota_coverage','profile_quota_entries'];
const privacyFenceTables=['privacy_writer_epochs','privacy_writer_leases'];
const retiredTables=['creative_devices','creative_pairings'];
// V7 F2 closed components (0069-0095): each table keeps its reviewed owner-only
// policies; no application role gains a row scope through this classification.
const privacyComponentTables=[
 'financial_retention_attestations','financial_retention_corrections','financial_retention_installations',
 'privacy_asset_apply_admissions','privacy_asset_batches','privacy_asset_completions',
 'privacy_backup_attestations','privacy_backup_file_sets','privacy_backup_revocations',
 'privacy_backup_row_entries','privacy_backup_row_pages','privacy_backup_row_seals','privacy_backup_row_sets',
 'privacy_hold_events','privacy_jobs','privacy_minimized_assets','privacy_minimized_records',
 'privacy_opaque_implementations','privacy_opaque_passes','privacy_policy_adoptions',
 'privacy_record_apply_admissions','privacy_record_batches','privacy_record_completions',
 'privacy_result_confirmations','privacy_result_preservations','privacy_result_seals'
];
const privacyReferenceTables=['privacy_reference_epoch','privacy_reference_leases'];
const cutoverTables=['profile_adoption_quarantine','profile_adoption_receipts','profile_role_adoptions'];
const platformTables=['platform_admins','platform_operations','platform_tokens'];
// V7 F1 (0111) and later: platform tables created after the retirement
// boundary. A catalog through 0108 (or 0109-0110) does not have them yet.
// V7 RF-01.5 (0117): platform deletion requests, outside every profile.
const addedAfterRetirement=['platform_backup_runs','platform_profile_deletions'];
// V7 RF-19.d: laboratory example receipts (0113), preserved only when present.
// V7 RF-07.e: owner alert mail (0116), profile scoped, preserved only when present.
// V7 RF-01.5: owner export receipts (0117), profile scoped, no content.
const profileAddedAfterRetirement=['owner_alert_mail_attempts','owner_alert_mail_jobs','profile_data_exports'];
const laboratoryAddedAfterRetirement=['commerce_number_lab.attachments','commerce_number_lab.retention_receipts','commerce_number_lab.suites','commerce_number_lab.suite_cases'];
// V7 F2 profile integrations (0101): reviewed profile and environment guards in
// the migration; only the API and the closed AI/platform readers reach rows.
const integrationTables=['ai_profile_preferences','meta_profile_credential_versions','meta_profile_credentials','profile_onboarding'];
// V7 F8-E: the tables migration 0109 drops. A catalog holds all of them
// (through 0108) or none (0109 onward); anything in between is refused.
const retiredByV7=new Set<string>(V7_RETIRED_TABLES);
const historicalTableNames=[...environmentTables,...sharedProfileTables,...globalIdentityTables,...privateLaboratoryTables,...quotaTables,...privacyFenceTables,...retiredTables,...privacyComponentTables,...privacyReferenceTables,...cutoverTables,...platformTables,...integrationTables,'profile_cutover_historical_tables','profiles','schema_migrations','ai_model_prices','manual_controls'].sort();
/** Metadata inventory only, for composition/review. Does not grant access.
 * The current schema (0109 onward); the historical one adds V7_RETIRED_TABLES. */
export const commerceProfileRowTableNames:readonly string[]=Object.freeze([...historicalTableNames.filter(name=>!retiredByV7.has(name)),...addedAfterRetirement,...profileAddedAfterRetirement,...laboratoryAddedAfterRetirement]);
export const commerceProfileHistoricalRowTableNames:readonly string[]=Object.freeze(historicalTableNames);
function check(value:unknown,code:string):asserts value{if(!value)throw Error(code);}

/** Pure, complete classification for the composed V7 schema through030.
 * This is not approval of catalog ACLs, functions, roles, policy bodies or mounts.
 * The independent row planner pins their native metadata before any DDL.
 */
export function commerceProfileRowPolicy(catalog:ProfileCatalog):ProfileRowIsolationPolicy{
 const all=[...catalog.tables.map(t=>[t.name,t] as const),...(catalog.non_public_tables??[]).map(t=>[t.schema+'.'+t.name,t] as const)];
 const rows=new Map(all);check(rows.size===all.length,'COMMERCE_ROW_DUPLICATE_RELATION');
 const result:Record<string,ProfileRowScope>={};
 const retiredPresent=V7_RETIRED_TABLES.filter(name=>rows.has(name)).length;
 check(retiredPresent===0||retiredPresent===V7_RETIRED_TABLES.length,'COMMERCE_ROW_RETIREMENT_PARTIAL');
 const dropped=retiredPresent===0,live=(names:readonly string[])=>dropped?names.filter(name=>!retiredByV7.has(name)):names;
 const add=(name:string,scope:ProfileRowScope)=>{check(rows.has(name)&&!result[name],'COMMERCE_ROW_RELATION_REQUIRED');result[name]=scope;};
 const scoped=(name:string,workspace:string,environment:string|null)=>{
  const table=rows.get(name);check(table,'COMMERCE_ROW_RELATION_REQUIRED');
  add(name,{mode:'scope',workspace,environment,roles:[...applicationRoles],initialize_permission:!table.rls});
 };
 for(const name of live(environmentTables))scoped(name,'workspace_id','environment');
 for(const name of live(sharedProfileTables))scoped(name,'workspace_id',null);
 for(const name of profileAddedAfterRetirement)if(rows.has(name))scoped(name,'workspace_id',null);
 scoped('profiles','id',null);
 for(const name of globalIdentityTables)add(name,{mode:'preserve',reason:'Global authenticated identity, separate from profile authority; identity pool and ACL review remain required.'});
 add('schema_migrations',{mode:'preserve',reason:'Global immutable migration metadata; no tenant business payload or profile authority.'});
 add('ai_model_prices',{mode:'preserve',reason:'Global immutable model price catalog; protected administration and grants remain separately reviewed.'});
 for(const name of quotaTables){const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_QUOTA_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Closed quota owner needs all adopted profiles for existing global counts; preserve reviewed020 policies and ACL.'});}
 for(const name of privacyFenceTables){const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_PRIVACY_FENCE_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Closed030 session leases and writer epochs are profile-wide authority; only the reviewed fence owner may access rows, through its exact scoped policies and ports.'});}
 const manual=rows.get('manual_controls');check(manual?.rls&&manual.force_rls,'COMMERCE_ROW_MANUAL_COMPONENT_REQUIRED');
 add('manual_controls',{mode:'preserve',reason:'Reviewed020 separates record environments while preserving the workspace stop shared across both environments.'});
 for(const name of live(retiredTables)){const row=rows.get(name),pol=catalog.policies.filter(p=>p.table===name);check(row?.rls&&row.force_rls&&pol.length===1&&pol[0]!.name==='retired_creative_custody'&&pol[0]!.command==='*'&&!pol[0]!.permissive&&pol[0]!.roles.length===1&&pol[0]!.roles[0]==='PUBLIC'&&pol[0]!.using==='false'&&pol[0]!.with_check==='false','COMMERCE_ROW_RETIRED_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Retired credentials remain administrative history under restrictive deny; no invented profile or environment.'});}
 for(const name of privateLaboratoryTables){const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_LAB_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Dedicated021 control is profile scoped with immutable source/budget REAL and execution SIMULATION dimensions; preserve its exact reviewed gates.'});}
 for(const name of privacyComponentTables){const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_PRIVACY_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Closed V7 privacy and financial retention custody; only its reviewed owner roles reach rows, through exact profile-scoped policies and ports.'});}
 for(const name of privacyReferenceTables){const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_PRIVACY_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Installation-wide privacy reference fence epoch and leases; no tenant business payload and no application role access.'});}
 for(const name of cutoverTables){const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_CUTOVER_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Immutable V7 cutover adoption receipts; written once by the migration owner and closed to application roles.'});}
 for(const name of platformTables){const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_PLATFORM_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Platform administration outside every profile; only the closed platform owner reaches rows, through aggregate-only ports.'});}
 for(const name of laboratoryAddedAfterRetirement){if(!rows.has(name))continue;const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_LAB_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Dedicated021 control of one profile run: sealed example receipts (RF-19.d), content-free retention receipts (RF-19.o) and automatic-buyer suites (RF-19.p); never a REAL asset.'});}
 for(const name of addedAfterRetirement){if(!rows.has(name))continue;const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_PLATFORM_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Platform recovery evidence outside every profile (V7 F1); only the cluster owner writes rows and the API reads a bounded status function.'});}
 for(const name of integrationTables){const row=rows.get(name);check(row?.rls&&row.force_rls,'COMMERCE_ROW_INTEGRATION_COMPONENT_REQUIRED');add(name,{mode:'preserve',reason:'Profile integration configuration with reviewed profile/environment guards; secrets are ciphertext readable only by their closed runtime role.'});}
 add('profile_cutover_historical_tables',{mode:'preserve',reason:'Global immutable list of historical table names used by the isolation model; no tenant data.'});
 check(Object.keys(result).length===rows.size,'COMMERCE_ROW_UNCLASSIFIED_RELATION');
 return{schema_version:1,tables:result};
}
