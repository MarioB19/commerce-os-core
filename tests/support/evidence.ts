// Test evidence never lives in versioned paths. The FULL gate re-reads
// `git status --porcelain --untracked-files=all` after every stage, so a test
// that writes under docs/ (or any tracked directory) fails the candidate with
// SOURCE_TREE_NOT_CLEAN even when every assertion passed.
//
// Default root: `test-evidence/` (git-ignored and Docker-ignored).
// Override: COMMERCE_TEST_EVIDENCE_DIR, absolute or relative to the repository.
// An override inside the repository must stay under an ignored prefix.
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const DEFAULT_TEST_EVIDENCE_DIR = 'test-evidence';
// Prefixes that .gitignore excludes; tests/ci/test_test_evidence_contract.py keeps them in sync.
export const IGNORED_EVIDENCE_PREFIXES = ['test-evidence', 'test-results', '.runtime', '.local'] as const;

function inside(root: string, target: string): string | null {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path)) ? path : null;
}

export function testEvidenceRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.COMMERCE_TEST_EVIDENCE_DIR?.trim();
  const root = resolve(repositoryRoot, configured || DEFAULT_TEST_EVIDENCE_DIR);
  const local = inside(repositoryRoot, root);
  if (local !== null) {
    const first = local.split(sep)[0];
    if (!(IGNORED_EVIDENCE_PREFIXES as readonly string[]).includes(first)) {
      throw new Error('TEST_EVIDENCE_DIR_VERSIONED');
    }
  }
  return root;
}

/** Resolve a relative evidence location (file or directory) without creating it. */
export function evidenceLocation(relativePath: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!relativePath || isAbsolute(relativePath)) throw new Error('TEST_EVIDENCE_RELATIVE_PATH_REQUIRED');
  const root = testEvidenceRoot(env);
  const target = resolve(root, relativePath);
  const local = inside(root, target);
  if (local === null || local === '') throw new Error('TEST_EVIDENCE_PATH_ESCAPES_ROOT');
  return target;
}

/** Resolve an evidence file and create its parent directory. */
export function evidencePath(relativePath: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = evidenceLocation(relativePath, env);
  mkdirSync(dirname(target), { recursive: true });
  return target;
}
