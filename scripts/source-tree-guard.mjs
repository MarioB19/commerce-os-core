// Runtime half of the test-evidence contract: a suite must leave the Git
// checkout exactly as it found it. The FULL gate only reports the generic
// SOURCE_TREE_NOT_CLEAN after every stage; the runners call this guard to fail
// early and name the offending paths. Ignored paths (test-evidence/, dist/,
// .runtime/ ...) never appear in `git status`, so they are allowed.
import { execFileSync } from 'node:child_process';

/** Porcelain entries for the checkout, or null when this is not a Git checkout. */
export function sourceTreeSnapshot(root = process.cwd(), exec = execFileSync) {
  try {
    const output = exec('git', ['-c', `safe.directory=${root}`, 'status', '--porcelain', '--untracked-files=all', '-z'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
    return new Set(String(output).split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

/** Entries that appeared during the run; empty when either snapshot is unavailable. */
export function sourceTreeWrites(before, after) {
  if (!before || !after) return [];
  return [...after].filter(entry => !before.has(entry)).sort();
}

/** Compare against a snapshot; log the paths and return a failing exit code if the suite wrote to the checkout. */
export function assertSourceTreeUnchanged(before, { suite, root = process.cwd(), log = console.error, snapshot = sourceTreeSnapshot } = {}) {
  const writes = sourceTreeWrites(before, snapshot(root));
  if (!writes.length) return 0;
  log(`TEST_WROTE_VERSIONED_PATHS (${suite}): ${writes.length} change(s) in the Git checkout. Write evidence with tests/support/evidence.ts (COMMERCE_TEST_EVIDENCE_DIR, default test-evidence/).`);
  for (const entry of writes.slice(0, 50)) log(`  ${entry}`);
  if (writes.length > 50) log(`  … ${writes.length - 50} more`);
  return 1;
}
