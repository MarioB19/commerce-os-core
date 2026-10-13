// Explicit reviewed browser contracts. They exercise loopback synthetic APIs;
// the existing mounted Playwright suite remains independently required.
export const browserContracts = Object.freeze([
  'scripts/test-profile-selector.mjs',
  'scripts/test-profile-application.mjs',
  'scripts/test-profile-settings.mjs',
  'scripts/test-profile-employees.mjs',
  'scripts/test-profile-invitations.mjs',
  'scripts/test-invitation-acceptance.mjs',
  'scripts/test-invitation-registration.mjs',
  'scripts/test-invitation-access.mjs',
  'scripts/test-profile-tokens.mjs',
  'scripts/test-profile-sales.mjs',
  'scripts/test-payments-register.mjs',
  'scripts/test-receipt-policies.mjs',
  'scripts/test-results.mjs',
]);
export async function runBrowserContracts(run) {
  for (const path of browserContracts) {
    const code = await run(process.execPath, [path]);
    if (code !== 0) return Number.isInteger(code) && code > 0 && code <= 255 ? code : 1;
  }
  return 0;
}
/** Always retain original Playwright filters and sanitize its reports, even
 * when a component contract fails. The first failure cannot become success. */
export async function runBrowserVerification(run, args) {
  let contracts, tests, sanitized;
  try {
    contracts = await runBrowserContracts(run);
    tests = await run('playwright', ['test', ...args]);
  } finally {
    sanitized = await run('python3', ['scripts/sanitize-test-artifacts.py']);
  }
  return {code: contracts || tests || sanitized, sanitized};
}
