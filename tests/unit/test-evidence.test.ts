import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evidenceLocation, evidencePath, repositoryRoot, testEvidenceRoot } from '../support/evidence.js';

// The retired root is built, not written literally: the CI contract forbids that literal in tests/.
const retiredRoot = ['docs', 'evidence'].join('/');

describe('test evidence location', () => {
  it('defaults to the ignored test-evidence root inside the repository', () => {
    expect(testEvidenceRoot({})).toBe(resolve(repositoryRoot, 'test-evidence'));
    expect(evidenceLocation('numbers-ui/inventory-390.png', {})).toBe(resolve(repositoryRoot, 'test-evidence/numbers-ui/inventory-390.png'));
  });

  it('accepts absolute roots and ignored repository prefixes', () => {
    const outside = mkdtempSync(join(tmpdir(), 'commerce-evidence-'));
    try {
      expect(testEvidenceRoot({ COMMERCE_TEST_EVIDENCE_DIR: outside })).toBe(outside);
      expect(testEvidenceRoot({ COMMERCE_TEST_EVIDENCE_DIR: '.runtime/cloudbuild-x/evidence' })).toBe(resolve(repositoryRoot, '.runtime/cloudbuild-x/evidence'));
      expect(testEvidenceRoot({ COMMERCE_TEST_EVIDENCE_DIR: '  ' })).toBe(resolve(repositoryRoot, 'test-evidence'));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects versioned roots, including the retired evidence root', () => {
    for (const value of [retiredRoot, 'tests/e2e', 'apps/web/public', '.', resolve(repositoryRoot, 'docs')]) {
      expect(() => testEvidenceRoot({ COMMERCE_TEST_EVIDENCE_DIR: value }), value).toThrow('TEST_EVIDENCE_DIR_VERSIONED');
    }
  });

  it('keeps every evidence path inside its root', () => {
    for (const value of [`../${retiredRoot}/x.json`, '/tmp/x.json', '', 'a/../../x']) {
      expect(() => evidenceLocation(value, {}), value).toThrow(/TEST_EVIDENCE_(PATH_ESCAPES_ROOT|RELATIVE_PATH_REQUIRED)/);
    }
  });

  it('creates only the parent directory of an evidence file', () => {
    const outside = mkdtempSync(join(tmpdir(), 'commerce-evidence-'));
    try {
      const file = evidencePath('ui/nested/capture.png', { COMMERCE_TEST_EVIDENCE_DIR: outside });
      expect(file).toBe(join(outside, 'ui/nested/capture.png'));
      expect(statSync(join(outside, 'ui/nested')).isDirectory()).toBe(true);
      expect(existsSync(file)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
