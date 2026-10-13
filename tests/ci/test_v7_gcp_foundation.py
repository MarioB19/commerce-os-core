import contextlib
import io
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import v7_gcp_foundation as m  # noqa: E402

SPEC = m.load_spec()


class FakeGoogle:
    """In-memory REST surface: resources by URL, IAM policies by URL."""

    def __init__(self):
        self.calls, self.resources, self.policies = [], {}, {}
        self.budgets = []
        self.vm = {'status': 'RUNNING', 'serviceAccounts': []}
        self.uptime = {'period': '60s', 'selectedRegions': ['USA', 'EUROPE', 'ASIA_PACIFIC'],
                       'httpCheck': {'path': '/readyz', 'port': 443, 'useSsl': True}}
        self.app = None
        self.run_service = None

    def __call__(self, method, url, body=None, *, missing_ok=False):
        self.calls.append((method, url, body))
        base = url.split('?')[0]
        if 'billingbudgets' in url:
            if method == 'GET':
                return {'budgets': self.budgets}
            created = dict(body, name='billingAccounts/x/budgets/1')
            self.budgets.append(created)
            return created
        if 'monitoring.googleapis.com' in url:
            if method == 'PATCH':
                self.uptime['httpCheck'] = body['httpCheck']
            return json.loads(json.dumps(self.uptime))
        if 'compute.googleapis.com' in url:
            if method == 'POST':
                self.vm['serviceAccounts'] = [{'email': body['email']}]
                return {}
            return self.vm
        if 'run.googleapis.com' in url:
            if base.endswith(':getIamPolicy'):
                return self.policies.get('run', {'bindings': []})
            if base.endswith(':setIamPolicy'):
                self.policies['run'] = body['policy']
                return body['policy']
            if method == 'GET':
                return self.run_service if missing_ok or self.run_service else self.run_service
            self.run_service = dict(body, uri='https://commerce-v7-ingress-x.a.run.app', terminalCondition={'state': 'CONDITION_SUCCEEDED'})
            return {'name': 'operations/run-1'}
        if 'appengine' in url or 'serviceusage' in url:
            if method == 'GET':
                return self.app
            return {'name': 'apps/x/operations/1'}
        if base.endswith(':setIamPolicy'):
            self.policies[base[:-len(':setIamPolicy')]] = body['policy']
            return body['policy']
        if base.endswith('/iam') and method == 'PUT':
            self.policies[base[:-4]] = body
            return body
        if base.endswith(':getIamPolicy'):
            return json.loads(json.dumps(self.policies.get(base[:-len(':getIamPolicy')], {'bindings': []})))
        if base.endswith('/iam'):
            return json.loads(json.dumps(self.policies.get(base[:-4], {'bindings': []})))
        if method == 'GET':
            found = self.resources.get(base)
            if found is None and not missing_ok:
                raise m.FoundationError('FOUNDATION_HTTP_404')
            return found
        if method in ('PUT', 'POST'):
            name = base
            if base.endswith('/serviceAccounts'):
                name = base + '/' + body['accountId'] + '@' + SPEC['project'] + '.iam.gserviceaccount.com'
            elif base.endswith('/storage/v1/b'):
                name = base + '/' + body['name']
            elif 'secretId=' in url:
                name = base + '/' + url.split('secretId=')[1]
            elif 'repositoryId=' in url:
                name = base + '/' + url.split('repositoryId=')[1]
            self.resources[name] = dict(body or {}, location=(body or {}).get('location'))
            return self.resources[name]
        raise AssertionError((method, url))


def run(fake, *argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = m.main(list(argv), google_factory=lambda: fake)
    return code, json.loads(out.getvalue())


class FoundationTests(unittest.TestCase):
    def test_plan_only_reads(self):
        fake = FakeGoogle()
        code, result = run(fake, 'plan')
        self.assertEqual(code, 0)
        self.assertTrue(all(method == 'GET' for method, _url, _body in fake.calls))
        self.assertEqual(set(result['service_accounts'].values()), {'MISSING'})
        self.assertEqual(result['budget'], {'state': 'MISSING'})

    def test_apply_creates_once_then_is_idempotent_and_never_removes_members(self):
        fake = FakeGoogle()
        code, first = run(fake, 'apply')
        self.assertEqual(code, 0, first)
        self.assertEqual(set(first['service_accounts'].values()), {'CREATED'})
        self.assertEqual(first['budget']['state'], 'CREATED')
        budget = fake.budgets[0]
        self.assertEqual(budget['amount']['specifiedAmount'], {'currencyCode': 'MXN', 'units': '1781', 'nanos': 395000000})
        self.assertEqual(budget['budgetFilter']['creditTypesTreatment'], 'EXCLUDE_ALL_CREDITS')
        self.assertIn({'thresholdPercent': 1.0, 'spendBasis': 'FORECASTED_SPEND'}, budget['thresholdRules'])
        bucket = next(body for method, url, body in fake.calls if method == 'POST' and url.endswith('?project=' + SPEC['project'])
                      and body['name'].startswith('commerce-v7-pitr'))
        self.assertEqual((bucket['location'], bucket['iamConfiguration']['publicAccessPrevention']), ('US-CENTRAL1', 'enforced'))
        subscription = next(body for method, url, body in fake.calls if method == 'PUT' and url.endswith('/subscriptions/commerce-v7-ingress-vm'))
        self.assertEqual(subscription['deadLetterPolicy']['maxDeliveryAttempts'], 10)
        self.assertTrue(subscription['enableMessageOrdering'])
        self.assertEqual(subscription['expirationPolicy'], {})
        # A pre-existing foreign member stays; a second apply adds nothing.
        key = 'https://pubsub.googleapis.com/v1/projects/' + SPEC['project'] + '/topics/commerce-v7-ingress'
        policy = fake.policies.get(key, {'bindings': []})
        policy['bindings'].append({'role': 'roles/viewer', 'members': ['user:someone@example.invalid']})
        fake.policies[key] = policy
        writes = len([c for c in fake.calls if c[0] != 'GET'])
        code, second = run(fake, 'apply')
        self.assertEqual(code, 0, second)
        self.assertTrue(all(v == 'EXISTS' for v in second['service_accounts'].values()))
        self.assertEqual(second['budget']['state'], 'EXISTS')
        self.assertTrue(all(not v['members_added'] for group in ('buckets', 'secrets', 'topics', 'subscriptions') for v in second[group].values()))
        self.assertEqual(len([c for c in fake.calls if c[0] != 'GET']), writes)
        self.assertIn({'role': 'roles/viewer', 'members': ['user:someone@example.invalid']}, fake.policies[key]['bindings'])

    def test_member_merge_is_additive(self):
        policy = {'etag': 'x', 'bindings': [{'role': 'r', 'members': ['user:a']}, {'role': 'c', 'members': ['user:z'], 'condition': {'title': 't'}}]}
        merged = m.with_members(policy, [('r', 'serviceAccount:b'), ('c', 'serviceAccount:b')])
        self.assertEqual(merged['etag'], 'x')
        self.assertIn({'role': 'r', 'members': ['serviceAccount:b', 'user:a']}, merged['bindings'])
        self.assertIn({'role': 'c', 'members': ['serviceAccount:b']}, merged['bindings'])
        self.assertIn({'role': 'c', 'members': ['user:z'], 'condition': {'title': 't'}}, merged['bindings'])

    def test_duplicate_budget_or_unsafe_vm_identity_stop(self):
        fake = FakeGoogle()
        fake.budgets = [{'displayName': SPEC['budget']['display_name'], 'name': 'a'}, {'displayName': SPEC['budget']['display_name'], 'name': 'b'}]
        self.assertEqual(run(fake, 'plan')[1]['error'], 'FOUNDATION_BUDGET_DUPLICATED')
        code, result = run(fake, 'vm-identity')
        self.assertEqual(result['error'], 'FOUNDATION_VM_MUST_BE_STOPPED')
        fake.vm['status'] = 'TERMINATED'
        code, result = run(fake, 'vm-identity')
        self.assertEqual(result['state'], 'VM_IDENTITY_REQUESTED')
        self.assertEqual(run(fake, 'vm-identity')[1]['state'], 'VM_IDENTITY_PRESENT')

    def test_uptime_path_and_appengine_location(self):
        fake = FakeGoogle()
        code, result = run(fake, 'uptime-path', '/healthz/platform')
        self.assertEqual((result['before'], result['after'], result['period']), ('/readyz', '/healthz/platform', '60s'))
        self.assertEqual(fake.uptime['httpCheck']['port'], 443)
        self.assertEqual(run(fake, 'uptime-path', '/other')[1]['error'], 'FOUNDATION_UPTIME_PATH')
        self.assertEqual(run(fake, 'appengine-create')[1]['state'], 'APPENGINE_CREATE_REQUESTED')
        fake.app = {'locationId': 'us-central', 'defaultHostname': 'x'}
        self.assertEqual(run(fake, 'appengine-create')[1]['error'], 'FOUNDATION_APPENGINE_OTHER_LOCATION')


class RelayDeployTests(unittest.TestCase):
    def test_relay_requires_digest_and_secret_version_then_public_invoker(self):
        fake = FakeGoogle()
        image = 'us-east1-docker.pkg.dev/' + SPEC['project'] + '/commerce-v7-runtime/ingress-relay@sha256:' + 'a' * 64
        self.assertEqual(run(fake, 'relay-deploy', image.replace('@sha256:' + 'a' * 64, ':latest'), '1')[1]['error'],
                         'FOUNDATION_RELAY_IMAGE_DIGEST_REQUIRED')
        self.assertEqual(run(fake, 'relay-deploy', image, 'latest')[1]['error'], 'FOUNDATION_RELAY_SECRET_VERSION_REQUIRED')
        code, result = run(fake, 'relay-deploy', image, '1')
        self.assertEqual((code, result['state'], result['existing']), (0, 'RELAY_DEPLOY_REQUESTED', False))
        container = fake.run_service['template']['containers'][0]
        self.assertEqual(fake.run_service['template']['scaling'], {'minInstanceCount': 0, 'maxInstanceCount': 2})
        self.assertIn({'name': 'RELAY_TOKEN', 'valueSource': {'secretKeyRef': {'secret': 'commerce-v7-ingress-relay-token', 'version': '1'}}},
                      container['env'])
        self.assertTrue(fake.run_service['template']['serviceAccount'].startswith('commerce-v7-ingress@'))
        code, public = run(fake, 'relay-public')
        self.assertEqual(public['members_added'], ['roles/run.invoker allUsers'])
        self.assertEqual(run(fake, 'relay-public')[1]['members_added'], [])


if __name__ == '__main__':
    unittest.main()
