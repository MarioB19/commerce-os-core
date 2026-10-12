"""Contract: test suites never write into versioned paths.

The FULL gate (scripts/cloudbuild-verify.py) re-reads
`git status --porcelain --untracked-files=all` after the last stage. FULL4668
passed 21 stages and still failed with SOURCE_TREE_NOT_CLEAN because E2E and
integration tests wrote evidence under docs/evidence/, which the public source
does not version. Evidence now goes through tests/support/evidence.ts into an
ignored, configurable directory. This contract keeps it that way:

* static: no literal write target in tests/ may resolve to a non-ignored path;
* static: the old docs/evidence root never reappears in test sources;
* wiring: the default root is git- and Docker-ignored, and both runners call the
  runtime guard (scripts/source-tree-guard.mjs), which names offending paths.
"""
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCANNED = ('e2e', 'integration', 'unit', 'support', 'fixtures')
EXTENSIONS = {'.ts', '.tsx', '.js', '.mjs', '.cjs'}
QUOTED = r"""(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1"""
# Calls whose first argument is a filesystem destination (or is deleted).
FIRST_ARGUMENT = re.compile(
    r'\b(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|createWriteStream|'
    r'truncate|truncateSync|rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|saveAs)\s*\(\s*' + QUOTED)
# Calls whose second argument is the destination.
SECOND_ARGUMENT = re.compile(
    r'\b(?:copyFile|copyFileSync|cp|cpSync|rename|renameSync|symlink|symlinkSync|link|linkSync)'
    r'\s*\(\s*[^,()]+,\s*' + QUOTED)
# Playwright artifacts written through an options object.
OPTION_PATH = re.compile(r'\b(?:screenshot|pdf|storageState)\s*\(\s*\{[^{}]*?\bpath\s*:\s*' + QUOTED, re.S)


def literal_targets(source):
    """Static prefixes of literal destinations; dynamic parts stop the prefix."""
    targets = []
    for pattern in (FIRST_ARGUMENT, SECOND_ARGUMENT, OPTION_PATH):
        for match in pattern.finditer(source):
            prefix = match.group(2).split('${', 1)[0]
            line = source.count('\n', 0, match.start()) + 1
            targets.append((line, prefix))
    return targets


def is_git_checkout():
    return subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--is-inside-work-tree'],
                          capture_output=True, text=True).stdout.strip() == 'true'


def ignored(relative):
    """True when the path, or anything inside it as a directory, is git-ignored."""
    for probe in (relative.rstrip('/'), relative.rstrip('/') + '/__evidence_probe__'):
        if subprocess.run(['git', '-C', str(ROOT), 'check-ignore', '-q', '--no-index', '--', probe]).returncode == 0:
            return True
    return False


def versioned_targets(source, check=ignored):
    """Literal relative destinations that are not git-ignored."""
    violations = []
    for line, prefix in literal_targets(source):
        if not prefix or prefix.startswith(('/', '~', 'http:', 'https:', 'data:', 'blob:')):
            continue  # absolute (temp/fixture) or non-file; runtime guard covers the rest
        relative = prefix[2:] if prefix.startswith('./') else prefix
        if relative.startswith('../') or not relative:
            continue
        if not check(relative):
            violations.append((line, prefix))
    return violations


def test_sources():
    for suite in SCANNED:
        for path in sorted((ROOT/'tests'/suite).rglob('*')):
            if path.suffix in EXTENSIONS and path.is_file() and 'node_modules' not in path.parts:
                yield path


class ScannerSelfTests(unittest.TestCase):
    """Prove the scanner catches the exact FULL4668 regression shapes."""

    def scan(self, source):
        return versioned_targets(source, check=lambda path: path.split('/')[0] in {'dist', 'test-evidence', 'test-results'})

    def test_detects_docs_evidence_writes(self):
        cases = [
            "await writeFile('docs/evidence/numbers-mcp-calendar.json',JSON.stringify(x));",
            "mkdirSync(\"docs/evidence\", { recursive: true });",
            "await page.screenshot({path:`docs/evidence/numbers-ui/inventory-${width}.png`,fullPage:true});",
            "await page.screenshot({\n  fullPage: true,\n  path: 'docs/evidence/screenshots/a.png',\n});",
            "await copyFile(capture.temporary,'docs/evidence/ui/a.png');",
            "writeFileSync('apps/web/src/generated.json','{}')",
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertTrue(self.scan(case), case)

    def test_allows_ignored_temporary_and_helper_destinations(self):
        cases = [
            "await writeFile(evidencePath('numbers-mcp-calendar.json'),'{}');",
            "await page.screenshot({path:evidencePath(`numbers-ui/${w}.png`)});",
            "await mkdir('dist',{recursive:true});",
            "await writeFile(join(directory,'token'),'x');",
            "await writeFile(`${directory}/token`,'x');",
            "await writeFile('/tmp/commerce-fixture.json','{}');",
            "await mkdir('test-evidence/v5-ui',{recursive:true});",
            "await copyFile(source,join(root,'a.png'));",
        ]
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual(self.scan(case), [], case)


class TestEvidenceContract(unittest.TestCase):
    def test_no_test_writes_to_a_versioned_literal_path(self):
        if not is_git_checkout():
            self.skipTest('requires the Git checkout to evaluate .gitignore')
        violations = []
        for path in test_sources():
            for line, prefix in versioned_targets(path.read_text(encoding='utf-8')):
                violations.append(f'{path.relative_to(ROOT)}:{line}: {prefix!r}')
        self.assertEqual(violations, [], 'Write test evidence with tests/support/evidence.ts:\n' + '\n'.join(violations))

    def test_old_docs_evidence_root_is_not_used_by_tests(self):
        offenders = [str(path.relative_to(ROOT)) for path in test_sources()
                     if 'docs/evidence' in path.read_text(encoding='utf-8')]
        self.assertEqual(offenders, [])

    def test_default_root_and_allowed_prefixes_are_ignored(self):
        helper = (ROOT/'tests/support/evidence.ts').read_text(encoding='utf-8')
        default = re.search(r"DEFAULT_TEST_EVIDENCE_DIR = '([^']+)'", helper)
        prefixes = re.search(r"IGNORED_EVIDENCE_PREFIXES = \[([^\]]+)\]", helper)
        self.assertIsNotNone(default)
        self.assertIsNotNone(prefixes)
        self.assertEqual(default.group(1), 'test-evidence')
        allowed = re.findall(r"'([^']+)'", prefixes.group(1))
        self.assertIn(default.group(1), allowed)
        self.assertNotIn('docs', allowed)
        dockerignore = (ROOT/'.dockerignore').read_text(encoding='utf-8').splitlines()
        self.assertIn('test-evidence', dockerignore)
        if not is_git_checkout():
            self.skipTest('requires the Git checkout to evaluate .gitignore')
        for prefix in allowed:
            with self.subTest(prefix=prefix):
                self.assertTrue(ignored(prefix + '/'), prefix)
        self.assertFalse(ignored('docs/evidence/'))

    def test_runners_fail_when_a_suite_dirties_the_checkout(self):
        for runner, suite in (('scripts/test-isolated.mjs', 'integration'), ('scripts/test-e2e.mjs', 'e2e')):
            with self.subTest(runner=runner):
                source = (ROOT/runner).read_text(encoding='utf-8')
                self.assertIn("from './source-tree-guard.mjs'", source)
                self.assertIn('const before = sourceTreeSnapshot();', source)
                self.assertIn(f"assertSourceTreeUnchanged(before, {{ suite: '{suite}' }})", source)

    def test_guard_reports_new_untracked_paths_but_not_ignored_ones(self):
        with tempfile.TemporaryDirectory() as directory:
            repository = Path(directory)
            subprocess.run(['git', 'init', '-q', str(repository)], check=True)
            (repository/'.gitignore').write_text('test-evidence/\n')
            script = (
                "import {sourceTreeSnapshot,sourceTreeWrites,assertSourceTreeUnchanged} from "
                + repr((ROOT/'scripts/source-tree-guard.mjs').as_uri()) + ";"
                "import {mkdirSync,writeFileSync} from 'node:fs';"
                "const root=process.argv[1];const before=sourceTreeSnapshot(root);"
                "mkdirSync(root+'/test-evidence',{recursive:true});writeFileSync(root+'/test-evidence/a.png','x');"
                "const clean=sourceTreeWrites(before,sourceTreeSnapshot(root));"
                "mkdirSync(root+'/docs/evidence',{recursive:true});writeFileSync(root+'/docs/evidence/a.json','{}');"
                "const lines=[];const code=assertSourceTreeUnchanged(before,{suite:'x',root,log:l=>lines.push(l)});"
                "console.log(JSON.stringify({clean,code,lines,missing:sourceTreeSnapshot('/')}));"
            )
            result = subprocess.run(['node', '--input-type=module', '-e', script, str(repository)],
                                    capture_output=True, text=True, check=True)
            import json
            report = json.loads(result.stdout)
            self.assertEqual(report['clean'], [])
            self.assertEqual(report['code'], 1)
            self.assertTrue(report['lines'][0].startswith('TEST_WROTE_VERSIONED_PATHS (x)'))
            self.assertIn('  ?? docs/evidence/a.json', report['lines'])
            self.assertIsNone(report['missing'])


if __name__ == '__main__':
    unittest.main()
