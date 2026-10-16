#!/usr/bin/env python3
"""V7 F1 GCP foundation as declarative data (infra/gcp/v7-foundation.json).

  python3 -I scripts/v7_gcp_foundation.py plan
  python3 -I scripts/v7_gcp_foundation.py apply
  python3 -I scripts/v7_gcp_foundation.py uptime-path </healthz/platform|/readyz>
  python3 -I scripts/v7_gcp_foundation.py vm-identity        # VM must already be TERMINATED
  python3 -I scripts/v7_gcp_foundation.py appengine-create   # irreversible per project: us-east1
  python3 -I scripts/v7_gcp_foundation.py relay-deploy <image@sha256> <secret-version>
  python3 -I scripts/v7_gcp_foundation.py relay-public       # after the revision is ready

The access token comes from GOOGLE_OAUTH_ACCESS_TOKEN (the owner's credential,
never stored). `plan` only reads. `apply` creates what is missing and adds
missing IAM members; it never deletes, renames or removes a member, and it
reports any drift it does not repair. Every call is a single REST request.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / 'infra/gcp/v7-foundation.json'


class FoundationError(RuntimeError):
    pass


def need(value, code):
    if not value:
        raise FoundationError(code)


class Google:
    """One JSON request per call; 404 is an observation, other errors stop."""

    def __init__(self, token, quota_project, opener=None):
        need(type(token) is str and 20 <= len(token) <= 4096 and re.fullmatch(r'[\x21-\x7e]+', token), 'FOUNDATION_TOKEN_REQUIRED')
        self.token, self.quota_project = token, quota_project
        self.opener = opener or urllib.request.build_opener()
        self.calls = []

    def __call__(self, method, url, body=None, *, missing_ok=False):
        need(urllib.parse.urlsplit(url).hostname.endswith('.googleapis.com'), 'FOUNDATION_ENDPOINT')
        data = None if body is None else json.dumps(body).encode()
        headers = {'Authorization': 'Bearer ' + self.token, 'x-goog-user-project': self.quota_project}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        self.calls.append((method, url))
        try:
            with self.opener.open(urllib.request.Request(url, data=data, method=method, headers=headers), timeout=60) as response:
                raw = response.read(4 * 1024 * 1024)
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            status = error.code
            detail = error.read(2000).decode('utf-8', 'replace')
            if status == 404 and missing_ok:
                return None
            message = ''
            try:
                message = json.loads(detail).get('error', {}).get('message', '')[:300]
            except ValueError:
                pass
            raise FoundationError('FOUNDATION_HTTP_' + str(status) + ':' + method + ' ' + url.split('?')[0] + ':' + message) from None


def load_spec(path=SPEC):
    spec = json.loads(Path(path).read_text())
    need(spec.get('schema_version') == 1 and re.fullmatch(r'[0-9]{6,20}', spec['project_number']), 'FOUNDATION_SPEC_INVALID')
    return spec


def member(spec, name):
    if name == '@pubsub-agent':
        return 'serviceAccount:service-' + spec['project_number'] + '@gcp-sa-pubsub.iam.gserviceaccount.com'
    need(name in spec['service_accounts'], 'FOUNDATION_UNKNOWN_IDENTITY:' + name)
    return 'serviceAccount:' + name + '@' + spec['project'] + '.iam.gserviceaccount.com'


def missing_members(policy, wanted):
    present = {(b['role'], m) for b in (policy or {}).get('bindings', []) for m in b.get('members', []) if not b.get('condition')}
    return sorted((role, m) for role, members in wanted.items() for m in members if (role, m) not in present)


def with_members(policy, additions):
    policy = dict(policy or {})
    bindings = [dict(b) for b in policy.get('bindings', [])]
    for role, m in additions:
        target = next((b for b in bindings if b['role'] == role and not b.get('condition')), None)
        if target is None:
            target = {'role': role, 'members': []}
            bindings.append(target)
        target['members'] = sorted(set(target.get('members', [])) | {m})
    policy['bindings'] = bindings
    return policy


class Foundation:
    def __init__(self, spec, google):
        self.spec, self.g = spec, google
        p = spec['project']
        self.iam = 'https://iam.googleapis.com/v1/projects/' + p + '/serviceAccounts'
        self.storage = 'https://storage.googleapis.com/storage/v1/b'
        self.secret = 'https://secretmanager.googleapis.com/v1/projects/' + p + '/secrets'
        self.pubsub = 'https://pubsub.googleapis.com/v1/projects/' + p

    def wanted(self, bindings):
        return {role: [member(self.spec, n) for n in names] for role, names in bindings.items()}

    def run(self, apply):
        report = {'service_accounts': {}, 'buckets': {}, 'secrets': {}, 'topics': {}, 'subscriptions': {}, 'budget': None, 'drift': []}
        p = self.spec['project']
        for name, sa in self.spec['service_accounts'].items():
            email = name + '@' + p + '.iam.gserviceaccount.com'
            found = self.g('GET', self.iam + '/' + email, missing_ok=True)
            state = 'EXISTS' if found else 'MISSING'
            if found and found.get('disabled'):
                report['drift'].append('SERVICE_ACCOUNT_DISABLED:' + name)
            if not found and apply:
                self.g('POST', self.iam, {'accountId': name, 'serviceAccount': {'displayName': sa['display_name'], 'description': sa['description']}})
                state = 'CREATED'
            report['service_accounts'][name] = state
        for name, bucket in self.spec['buckets'].items():
            found = self.g('GET', self.storage + '/' + name, missing_ok=True)
            state = 'EXISTS' if found else 'MISSING'
            if found:
                if found.get('location') != bucket['location']:
                    report['drift'].append('BUCKET_LOCATION:' + name)
                iam_cfg = found.get('iamConfiguration', {})
                if not iam_cfg.get('uniformBucketLevelAccess', {}).get('enabled') or iam_cfg.get('publicAccessPrevention') != 'enforced':
                    report['drift'].append('BUCKET_ACCESS_CONTROL:' + name)
            elif apply:
                self.g('POST', self.storage + '?project=' + p, {'name': name, 'location': bucket['location'], 'storageClass': 'STANDARD',
                       'iamConfiguration': {'uniformBucketLevelAccess': {'enabled': True}, 'publicAccessPrevention': 'enforced'},
                       'labels': {'product': 'commerce-os', 'phase': 'v7-f1'}})
                state = 'CREATED'
            report['buckets'][name] = {'state': state, 'members_added': self.bind(self.storage + '/' + name + '/iam', bucket['bindings'], apply, state, put=True)}
        for name, secret in self.spec['secrets'].items():
            found = self.g('GET', self.secret + '/' + name, missing_ok=True)
            state = 'EXISTS' if found else 'MISSING'
            if not found and apply:
                self.g('POST', self.secret + '?secretId=' + name, {'replication': {'automatic': {}}, 'labels': {'product': 'commerce-os', 'phase': 'v7-f1'}})
                state = 'CREATED'
            report['secrets'][name] = {'state': state, 'members_added': self.bind(self.secret + '/' + name + ':getIamPolicy', secret['bindings'], apply, state,
                                                                                  set_url=self.secret + '/' + name + ':setIamPolicy')}
        for name, topic in self.spec['topics'].items():
            url = self.pubsub + '/topics/' + name
            found = self.g('GET', url, missing_ok=True)
            state = 'EXISTS' if found else 'MISSING'
            if not found and apply:
                self.g('PUT', url, {'labels': {'product': 'commerce-os', 'phase': 'v7-f1'}})
                state = 'CREATED'
            report['topics'][name] = {'state': state, 'members_added': self.bind(url + ':getIamPolicy', topic['bindings'], apply, state,
                                                                                 set_url=url + ':setIamPolicy')}
        for name, sub in self.spec['subscriptions'].items():
            url = self.pubsub + '/subscriptions/' + name
            body = {'topic': 'projects/' + p + '/topics/' + sub['topic'], 'ackDeadlineSeconds': sub['ack_deadline_seconds'],
                    'messageRetentionDuration': sub['retention'], 'enableMessageOrdering': sub['ordering'],
                    'expirationPolicy': {}, 'labels': {'product': 'commerce-os', 'phase': 'v7-f1'}}
            if sub.get('dead_letter'):
                body['deadLetterPolicy'] = {'deadLetterTopic': 'projects/' + p + '/topics/' + sub['dead_letter']['topic'],
                                            'maxDeliveryAttempts': sub['dead_letter']['max_delivery_attempts']}
            if sub.get('retry'):
                body['retryPolicy'] = {'minimumBackoff': sub['retry']['minimum'], 'maximumBackoff': sub['retry']['maximum']}
            found = self.g('GET', url, missing_ok=True)
            state = 'EXISTS' if found else 'MISSING'
            if found:
                for key in ('topic', 'enableMessageOrdering', 'ackDeadlineSeconds'):
                    if found.get(key, False if key == 'enableMessageOrdering' else None) != body[key]:
                        report['drift'].append('SUBSCRIPTION_' + key.upper() + ':' + name)
            elif apply:
                self.g('PUT', url, body)
                state = 'CREATED'
            report['subscriptions'][name] = {'state': state, 'members_added': self.bind(url + ':getIamPolicy', sub['bindings'], apply, state,
                                                                                        set_url=url + ':setIamPolicy')}
        for name, repo in self.spec.get('artifact_repositories', {}).items():
            base = ('https://artifactregistry.googleapis.com/v1/projects/' + p + '/locations/' + repo['location'] + '/repositories')
            found = self.g('GET', base + '/' + name, missing_ok=True)
            state = 'EXISTS' if found else 'MISSING'
            if found and found.get('format') != 'DOCKER':
                report['drift'].append('REPOSITORY_FORMAT:' + name)
            if not found and apply:
                self.g('POST', base + '?repositoryId=' + name, {'format': 'DOCKER', 'description': repo['description'],
                                                                  'labels': {'product': 'commerce-os', 'phase': 'v7-f1'}})
                state = 'CREATED'
            report.setdefault('artifact_repositories', {})[name] = state
        report['budget'] = self.budget(apply)
        return report

    def bind(self, get_url, bindings, apply, state, *, set_url=None, put=False):
        wanted = self.wanted(bindings)
        if not wanted:
            return []
        if state == 'MISSING':
            return [role + ' ' + m for role, ms in wanted.items() for m in ms]
        policy = self.g('GET', get_url)
        additions = missing_members(policy, wanted)
        if additions and apply:
            updated = with_members(policy, additions)
            if put:
                self.g('PUT', get_url, updated)
            else:
                self.g('POST', set_url, {'policy': updated})
        return [role + ' ' + m for role, m in additions]

    def budget(self, apply):
        b, base = self.spec['budget'], 'https://billingbudgets.googleapis.com/v1/billingAccounts/' + self.spec['billing_account'] + '/budgets'
        listed = self.g('GET', base) or {}
        found = [x for x in listed.get('budgets', []) if x.get('displayName') == b['display_name']]
        need(len(found) <= 1, 'FOUNDATION_BUDGET_DUPLICATED')
        if found:
            amount = found[0].get('amount', {}).get('specifiedAmount', {})
            ok = amount.get('currencyCode') == b['currency'] and str(amount.get('units')) == b['units'] and int(amount.get('nanos', 0)) == b['nanos']
            return {'state': 'EXISTS' if ok else 'DRIFT', 'name': found[0]['name']}
        if not apply:
            return {'state': 'MISSING'}
        created = self.g('POST', base, {'displayName': b['display_name'],
            'budgetFilter': {'projects': ['projects/' + self.spec['project_number']], 'creditTypesTreatment': 'EXCLUDE_ALL_CREDITS'},
            'amount': {'specifiedAmount': {'currencyCode': b['currency'], 'units': b['units'], 'nanos': b['nanos']}},
            'thresholdRules': [{'thresholdPercent': t, 'spendBasis': basis} for t, basis in b['thresholds']],
            'notificationsRule': {'monitoringNotificationChannels': [b['notification_channel']], 'disableDefaultIamRecipients': False}})
        return {'state': 'CREATED', 'name': created.get('name')}

    def uptime_path(self, path):
        need(path in ('/healthz/platform', '/readyz'), 'FOUNDATION_UPTIME_PATH')
        url = 'https://monitoring.googleapis.com/v3/' + self.spec['uptime_check']
        current = self.g('GET', url)
        check = dict(current['httpCheck'])
        before = check.get('path')
        check['path'] = path
        self.g('PATCH', url + '?updateMask=httpCheck', {'httpCheck': check})
        after = self.g('GET', url)
        need(after['httpCheck']['path'] == path and after['period'] == current['period']
             and after.get('selectedRegions') == current.get('selectedRegions'), 'FOUNDATION_UPTIME_READBACK')
        return {'state': 'UPTIME_PATH_SET', 'before': before, 'after': path, 'period': after['period']}

    def vm_identity(self):
        vm = self.spec['vm']
        url = ('https://compute.googleapis.com/compute/v1/projects/' + self.spec['project'] + '/zones/' + vm['zone'] + '/instances/' + vm['name'])
        current = self.g('GET', url)
        email = vm['service_account'] + '@' + self.spec['project'] + '.iam.gserviceaccount.com'
        accounts = current.get('serviceAccounts') or []
        if [a.get('email') for a in accounts] == [email]:
            return {'state': 'VM_IDENTITY_PRESENT', 'email': email}
        need(current.get('status') == 'TERMINATED', 'FOUNDATION_VM_MUST_BE_STOPPED')
        self.g('POST', url + '/setServiceAccount', {'email': email, 'scopes': ['https://www.googleapis.com/auth/cloud-platform']})
        return {'state': 'VM_IDENTITY_REQUESTED', 'email': email, 'previous': [a.get('email') for a in accounts]}

    def relay_deploy(self, image, secret_version):
        r, p = self.spec['relay'], self.spec['project']
        need(re.fullmatch(r'us-east1-docker\.pkg\.dev/' + re.escape(p) + r'/commerce-v7-runtime/ingress-relay@sha256:[a-f0-9]{64}', image or ''),
             'FOUNDATION_RELAY_IMAGE_DIGEST_REQUIRED')
        need(re.fullmatch(r'[1-9][0-9]*', secret_version or ''), 'FOUNDATION_RELAY_SECRET_VERSION_REQUIRED')
        base = 'https://run.googleapis.com/v2/projects/' + p + '/locations/' + self.spec['region'] + '/services'
        service = {'ingress': 'INGRESS_TRAFFIC_ALL', 'labels': {'product': 'commerce-os', 'phase': 'v7-f1'},
                   'template': {'serviceAccount': r['service_account'] + '@' + p + '.iam.gserviceaccount.com',
                                'scaling': {'minInstanceCount': 0, 'maxInstanceCount': r['max_instances']},
                                'maxInstanceRequestConcurrency': 40, 'timeout': '30s',
                                'containers': [{'image': image, 'ports': [{'containerPort': 8080}],
                                                'resources': {'limits': {'cpu': '1', 'memory': r['memory']}, 'cpuIdle': True},
                                                'env': [{'name': 'PUBSUB_TOPIC', 'value': 'projects/' + p + '/topics/' + r['topic']},
                                                        {'name': 'RELAY_TOKEN', 'valueSource': {'secretKeyRef': {'secret': r['secret'], 'version': secret_version}}}]}]}}
        found = self.g('GET', base + '/' + r['service'], missing_ok=True)
        if found:
            operation = self.g('PATCH', base + '/' + r['service'], service)
        else:
            operation = self.g('POST', base + '?serviceId=' + r['service'], service)
        policy = self.g('GET', base + '/' + r['service'] + ':getIamPolicy') if found else {'bindings': []}
        additions = missing_members(policy, {'roles/run.invoker': ['allUsers']})
        return {'state': 'RELAY_DEPLOY_REQUESTED', 'operation': (operation or {}).get('name'), 'existing': bool(found),
                'public_invoker_pending': bool(additions)}

    def relay_public(self):
        r, p = self.spec['relay'], self.spec['project']
        url = 'https://run.googleapis.com/v2/projects/' + p + '/locations/' + self.spec['region'] + '/services/' + r['service']
        service = self.g('GET', url)
        need(service.get('terminalCondition', {}).get('state') == 'CONDITION_SUCCEEDED', 'FOUNDATION_RELAY_NOT_READY')
        policy = self.g('GET', url + ':getIamPolicy')
        additions = missing_members(policy, {'roles/run.invoker': ['allUsers']})
        if additions:
            self.g('POST', url + ':setIamPolicy', {'policy': with_members(policy, additions)})
        return {'state': 'RELAY_PUBLIC', 'uri': service.get('uri'), 'image': service['template']['containers'][0]['image'],
                'members_added': [role + ' ' + m for role, m in additions]}

    def appengine_create(self):
        existing = self.g('GET', 'https://appengine.googleapis.com/v1/apps/' + self.spec['project'], missing_ok=True)
        if existing:
            need(existing.get('locationId') == self.spec['app_engine']['location'], 'FOUNDATION_APPENGINE_OTHER_LOCATION')
            return {'state': 'APPENGINE_EXISTS', 'location': existing['locationId'], 'hostname': existing.get('defaultHostname')}
        self.g('POST', 'https://serviceusage.googleapis.com/v1/projects/' + self.spec['project_number'] + '/services/appengine.googleapis.com:enable', {})
        operation = self.g('POST', 'https://appengine.googleapis.com/v1/apps', {'id': self.spec['project'], 'locationId': self.spec['app_engine']['location']})
        return {'state': 'APPENGINE_CREATE_REQUESTED', 'operation': operation.get('name')}


def main(argv=None, google_factory=None):
    argv = argv if argv is not None else sys.argv[1:]
    need(argv and argv[0] in ('plan', 'apply', 'uptime-path', 'vm-identity', 'appengine-create', 'relay-deploy', 'relay-public'),
         'FOUNDATION_COMMAND')
    spec = load_spec()
    google = (google_factory or (lambda: Google(os.environ.get('GOOGLE_OAUTH_ACCESS_TOKEN', ''), spec['project'])))()
    foundation = Foundation(spec, google)
    command = argv[0]
    try:
        if command in ('plan', 'apply'):
            result = {'state': 'FOUNDATION_' + command.upper(), **foundation.run(command == 'apply')}
        elif command == 'uptime-path':
            result = foundation.uptime_path(argv[1] if len(argv) > 1 else '')
        elif command == 'vm-identity':
            result = foundation.vm_identity()
        elif command == 'relay-deploy':
            result = foundation.relay_deploy(*(argv[1:3] + [''] * (3 - len(argv)))[:2])
        elif command == 'relay-public':
            result = foundation.relay_public()
        else:
            result = foundation.appengine_create()
        code = 0
    except FoundationError as error:
        result, code = {'state': 'FOUNDATION_ERROR', 'error': str(error)}, 2
    result['calls'] = len(google.calls)
    print(json.dumps(result, sort_keys=True))
    return code


if __name__ == '__main__':
    sys.exit(main())
