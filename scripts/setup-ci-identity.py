#!/usr/bin/env python3
"""One-time, authorized Cloud Shell setup. No exported service-account keys."""
import json
import subprocess
import urllib.request

PROJECT = 'vibe-conversa-prod'
ZONE = 'us-east1-d'
INSTANCE = 'vibe-conversa-prod'
POOL = 'commerce-os-cd'
SA = f'commerce-os-deploy@{PROJECT}.iam.gserviceaccount.com'
MEMBER = f'serviceAccount:{SA}'

def g(*args):
    result = subprocess.run(['gcloud', *args, '--quiet', '--format=json'], text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return json.loads(result.stdout) if result.stdout.strip() else None

def ensure(describe, create):
    result = subprocess.run(['gcloud', *describe, '--format=json'], text=True, capture_output=True)
    if result.returncode == 0:
        return json.loads(result.stdout)
    if 'NOT_FOUND' not in result.stderr and 'not found' not in result.stderr:
        raise RuntimeError(result.stderr)
    g(*create)
    return g(*describe)

def main():
    project_number = g('projects', 'describe', PROJECT)['projectNumber']
    vm = g('compute', 'instances', 'describe', INSTANCE, f'--project={PROJECT}', f'--zone={ZONE}')
    if vm.get('serviceAccounts'):
        raise RuntimeError('Review service-account actAs requirement before changing IAM')
    g('services', 'enable', 'iam.googleapis.com', 'iamcredentials.googleapis.com', 'sts.googleapis.com', f'--project={PROJECT}')
    ensure(['iam','service-accounts','describe',SA,f'--project={PROJECT}'], ['iam','service-accounts','create','commerce-os-deploy',f'--project={PROJECT}','--display-name=Commerce OS deployment'])
    ensure(['iam','workload-identity-pools','describe',POOL,f'--project={PROJECT}','--location=global'], ['iam','workload-identity-pools','create',POOL,f'--project={PROJECT}','--location=global','--display-name=Commerce OS GitHub deployment'])
    mapping = 'google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref'
    # New repositories use immutable IDs in sub (GitHub rollout July 2026).
    condition = "assertion.repository_id == '1359063164' && assertion.repository_owner_id == '133941077' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == 'MarioB19/commerce-os/.github/workflows/ci.yml@refs/heads/main' && assertion.sub == 'repo:MarioB19@133941077/commerce-os@1359063164:environment:production'"
    base = [f'--project={PROJECT}','--location=global',f'--workload-identity-pool={POOL}']
    provider = ensure(['iam','workload-identity-pools','providers','describe','github',*base], ['iam','workload-identity-pools','providers','create-oidc','github',*base,'--issuer-uri=https://token.actions.githubusercontent.com',f'--attribute-mapping={mapping}',f'--attribute-condition={condition}'])
    if provider.get('attributeCondition') != condition:
        raise RuntimeError('Existing provider trust differs; inspect before updating')
    g('iam','service-accounts','add-iam-policy-binding',SA,f'--project={PROJECT}','--role=roles/iam.workloadIdentityUser',f'--member=principalSet://iam.googleapis.com/projects/{project_number}/locations/global/workloadIdentityPools/{POOL}/attribute.repository_id/1359063164')
    permissions = ['compute.instances.get','compute.instances.list','compute.projects.get','resourcemanager.projects.get']
    role = ensure(['iam','roles','describe','commerceDeployLookup',f'--project={PROJECT}'], ['iam','roles','create','commerceDeployLookup',f'--project={PROJECT}','--title=Commerce deploy instance lookup','--permissions='+','.join(permissions),'--stage=GA'])
    if sorted(role['includedPermissions']) != sorted(permissions):
        raise RuntimeError('Existing lookup role differs')
    g('projects','add-iam-policy-binding',PROJECT,f'--member={MEMBER}',f'--role=projects/{PROJECT}/roles/commerceDeployLookup','--condition=None')
    g('compute','instances','add-iam-policy-binding',INSTANCE,f'--project={PROJECT}',f'--zone={ZONE}',f'--member={MEMBER}','--role=roles/compute.osAdminLogin')
    token = subprocess.check_output(['gcloud','auth','print-access-token'],text=True).strip()
    url = f'https://iap.googleapis.com/v1/projects/{project_number}/iap_tunnel/zones/{ZONE}/instances/{vm["id"]}'
    def request(method, data):
        req=urllib.request.Request(url+':'+method, data=json.dumps(data).encode(), headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)
    policy = request('getIamPolicy', {'options': {'requestedPolicyVersion': 3}})
    binding = {'role':'roles/iap.tunnelResourceAccessor','members':[MEMBER],'condition':{'title':'commerce-os-ssh-only','expression':'destination.port == 22'}}
    if binding not in policy.setdefault('bindings', []):
        policy['bindings'].append(binding)
        policy['version'] = 3
        request('setIamPolicy', {'policy': policy})
    print(json.dumps({'configured':True,'provider':provider['name'],'service_account':SA,'project':PROJECT,'instance':INSTANCE,'zone':ZONE,'service_account_keys_created':0,'iap_target_instances':1}))

if __name__ == '__main__':
    main()
