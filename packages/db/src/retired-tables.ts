/** V7 F8-E: the tables migration 0109 drops (V5 Inteligencia, SearchAPI, the
 * R2 library, the creative studio, finished-asset intake, provider/integration
 * diagnostics and sponsorships). The isolation classifications accept a
 * catalog either with all of them (through 0108) or with none (0109 onward). */
export const V7_RETIRED_TABLES=[
 'intelligence_searches','intelligence_runs','intelligence_offers','intelligence_observations','intelligence_analyses',
 'intelligence_opportunities','intelligence_analysis_batches','intelligence_corpus_evaluations',
 'creative_artifacts','creative_assets','creative_attempts','creative_batch_versions','creative_batches','creative_budgets',
 'creative_conformities','creative_devices','creative_global_budgets','creative_jobs','creative_members','creative_pairings',
 'creative_playbook_receipts','creative_projects','creative_provider_operations','creative_quotes','creative_recipe_intakes',
 'creative_recipe_versions','creative_recipes','creative_reviews','creative_settings','creative_steps','creative_storage_usage',
 'creative_uploads','creative_voice_brief_versions','creative_voice_briefs','creative_voice_operations',
 'finished_asset_intakes','provider_diagnostics','integration_diagnostics','mcl_sponsorships',
] as const;
export type RetiredTable=typeof V7_RETIRED_TABLES[number];
export const V7_RETIREMENT_MIGRATION='0109_v7_retire_modules.sql';
