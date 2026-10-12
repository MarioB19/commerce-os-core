// Canonical names created by reviewed additive transitions. This is fixture
// cleanup authority, never a native migration, DROP OWNED or CASCADE facility.
const reviewedRoles = Object.freeze({
  commerce_ai: true,
  commerce_mail_dispatch: true,
  commerce_results: false,
  commerce_results_reader: false,
  commerce_result_custody: false,
  commerce_privacy_worker: false,
  commerce_privacy_inventory_owner: false,
  commerce_privacy_fence_owner: false,
  commerce_privacy_fence_worker: false,
  commerce_privacy_job_owner: false,
  commerce_privacy_attestor: false,
  commerce_privacy_job_worker: false,
  commerce_financial_retention: false,
  commerce_privacy_record_eraser: false,
  commerce_privacy_file_owner: false,
  commerce_privacy_opaque_owner: false,
  commerce_privacy_opaque_attestor: false,
  commerce_privacy_reference_owner: false,
  commerce_privacy_reference_worker: false,
  commerce_privacy_asset_reference: false,
  commerce_privacy_row_owner: false,
  commerce_quota_owner: false,
  commerce_global_budget_reader: false,
  commerce_number_lab: true,
  commerce_number_lab_owner: true,
  commerce_profile_bootstrap_owner: false,
  commerce_authorization_reader: false,
  commerce_isolation_reader: false,
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export async function captureIntegrationRoles(client) {
  const roles = (await client.query(`/* integration-role-snapshot */
    SELECT oid::text oid,rolname::text name,rolcanlogin login,rolsuper superuser,
    rolbypassrls bypass,rolcreatedb create_db,rolcreaterole create_role,
    rolreplication replication,rolinherit inherit,rolconnlimit connection_limit,
    COALESCE(rolconfig,ARRAY[]::text[]) config FROM pg_roles ORDER BY oid`)).rows;
  const memberships = (await client.query(`/* integration-role-memberships */
    SELECT roleid::text role,member::text member,grantor::text grantor,
    admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor`)).rows;
  if (!Array.isArray(roles) || roles.length > 512 || !Array.isArray(memberships) || memberships.length > 4096 ||
    roles.some(r => !/^\d+$/.test(r.oid) || typeof r.name !== 'string') ||
    new Set(roles.map(r => r.oid)).size !== roles.length || new Set(roles.map(r => r.name)).size !== roles.length) throw Error('INTEGRATION_ROLE_SNAPSHOT_INVALID');
  return { roles, memberships };
}
export async function prepareIntegrationRoleCleanup(client, baseline, database) {
  if (!/^commerce_test_\d+_[a-f0-9]{32}$/.test(database)) throw Error('INTEGRATION_ROLE_DATABASE_INVALID');
  const current = await captureIntegrationRoles(client), old = new Map(baseline.roles.map(r => [r.oid, r]));
  if (baseline.roles.some(r => !same(r, current.roles.find(n => n.oid === r.oid))) || !same(baseline.memberships, current.memberships)) throw Error('INTEGRATION_PREEXISTING_ROLE_CHANGED');
  const created = current.roles.filter(r => !old.has(r.oid));
  for (const role of created) {
    if (!Object.hasOwn(reviewedRoles, role.name) || role.login !== false || role.superuser !== false || role.bypass !== false ||
      role.create_db !== false || role.create_role !== false || role.replication !== false || role.inherit !== reviewedRoles[role.name] ||
      role.connection_limit !== -1 || !Array.isArray(role.config) || role.config.length) throw Error('INTEGRATION_NEW_ROLE_UNREVIEWED');
  }
  const db = (await client.query('/* integration-role-database */ SELECT oid::text oid FROM pg_database WHERE datname=$1', [database])).rows;
  if (db.length !== 1 || !/^\d+$/.test(db[0].oid)) throw Error('INTEGRATION_ROLE_DATABASE_MISSING');
  if (created.length) {
    const dependencies = (await client.query(`/* integration-role-dependencies */
      SELECT dbid::text database,refobjid::text role FROM pg_shdepend
      WHERE refclassid='pg_authid'::regclass AND refobjid=ANY($1::oid[]) ORDER BY dbid,refobjid`, [created.map(r => r.oid)])).rows;
    if (dependencies.some(d => d.database !== db[0].oid)) throw Error('INTEGRATION_ROLE_FOREIGN_DEPENDENCY');
  }
  return Object.freeze({ database, baseline, current, created });
}
export async function finishIntegrationRoleCleanup(client, plan) {
  // No role is removed until the exact successful fixture database is gone.
  if ((await client.query('/* integration-role-database */ SELECT oid::text oid FROM pg_database WHERE datname=$1', [plan.database])).rows.length) throw Error('INTEGRATION_ROLE_DATABASE_RETAINED');
  if (!same(await captureIntegrationRoles(client), plan.current)) throw Error('INTEGRATION_ROLE_CLEANUP_DRIFT');
  if (plan.created.length) {
    const deps = (await client.query(`/* integration-role-dependencies */ SELECT dbid::text database,refobjid::text role FROM pg_shdepend
      WHERE refclassid='pg_authid'::regclass AND refobjid=ANY($1::oid[]) ORDER BY dbid,refobjid`, [plan.created.map(r => r.oid)])).rows;
    if (deps.length) throw Error('INTEGRATION_ROLE_DEPENDENCY_REMAINS');
    // PostgreSQL makes this statement atomic and refuses concurrent dependencies.
    // A preexisting role can never enter plan.created; no CASCADE is available.
    await client.query('DROP ROLE ' + plan.created.map(r => '"' + r.name + '"').join(','));
  }
  if (!same(await captureIntegrationRoles(client), plan.baseline)) throw Error('INTEGRATION_ROLE_BASELINE_NOT_RESTORED');
  return { state: 'ISOLATED_TEST_ROLES_REMOVED', database: plan.database, roles: plan.created.map(r => r.name) };
}
