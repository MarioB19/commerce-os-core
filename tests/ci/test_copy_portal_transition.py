import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import api_web_deployment as guards
import copy_portal_deployment as portal
from ci_release import ReleaseError
from mcl_portal_release import MIGRATION_MAINTENANCE_BLOCK, portal_env, rewrite_portal
import test_copy_portal_state as state_fixture
import test_api_web_deployment as api_fixture
from deployment_scope import deployment_scope, COPY_TARGET, LEGACY_TARGET


class CopyPortalTransitionTests(unittest.TestCase):
    def fixture(self):
        fixture=state_fixture.CopyPortalStateTests();private=fixture.private
        current=Path('/opt/commerce-os/releases/current');root=Path('/opt/commerce-os/releases/portal-ci-100-1')
        rows=fixture.rows();services={name:row for name,row in zip(('api','web','postgres','caddy','portal'),rows)}
        memberships,networks,release,kernel=api_fixture.ApiWebGatewayTests().topology()
        release['COMMERCE_PROXY_NETWORK']='owned-proxy'
        networks={('owned-proxy' if key=='proxy' else key):row for key,row in networks.items()}
        for name,row in services.items():
            names={'owned-proxy'} if name=='portal' else set(memberships[name]['NetworkSettings']['Networks'])
            names={'owned-proxy' if key=='proxy' else key for key in names}
            row['NetworkSettings']={'Networks':{key:{'GwPriority':1 if key=='edge' else 0} for key in names}}
        network_rows=[]
        for index,(name,row) in enumerate(networks.items()):
            row.update(Name=name,Id=str(index)*64,Driver='bridge',Options={},Labels={})
            row['Containers']={value['Id']:{} for value in services.values() if name in value['NetworkSettings']['Networks']}
            network_rows.append(row)
        state=fixture.state();state['network_baseline']={row['Name']:{key:row[key] for key in
            ('Name','Id','Driver','Internal','EnableIPv6','IPAM','Options','Labels')} for row in network_rows}
        state['caddy_config_ref']['path']='/private-owned/Caddyfile'
        files={private/name:b'DUMMY=value\n' for name in guards.FILES}
        files[private/'release.env']=''.join(key+'='+value+'\n' for key,value in release.items()).encode()
        before={'state':state,'state_raw':b'state','plan_raw':b'plan',
                'services':{key:value for key,value in services.items() if key!='portal'},
                'files':{name:files[private/name] for name in guards.FILES}}
        inputs='MCL_SESSION_SECRET='+'1'*64+'\nMCL_CORE_CODES_SHA256='+'2'*64+'\nMCL_KIT_CODES_SHA256='+'3'*64+'\nNEXT_PUBLIC_SITE_URL=https://ciclo.inovaris.online\n'
        files.update({private/'api-web-adoption.json':b'state',private/'daily-b02'/'plan.json':b'plan',
            guards.PORTAL_BASE/'releases'/'100-1'/'runtime.env':portal_env(inputs,'c'*40).encode(),
            root/'portal-manifest.json':json.dumps({'source_sha':'c'*40,'origin':'https://ciclo.inovaris.online',
                'pdfs':{str(index)+'.pdf':'a'*64 for index in range(10)}}).encode(),
            Path('/private-owned/Caddyfile'):rewrite_portal(MIGRATION_MAINTENANCE_BLOCK,'mcl-portal-100-1',allow_migration_maintenance=True)})
        receipt={'run_id':'100-1','source_sha':'c'*40,'image':fixture.portal()['image'],'proxy_network':'owned-proxy'}
        def command(args,_root):
            if args[:3]==['docker','ps','-aq']:return ' '.join(row['Id'] for row in rows)
            if args[:2]==['docker','inspect']:
                return json.dumps([services['portal']] if args[2]=='mcl-portal-100-1' else rows)
            if args[:3]==['docker','network','inspect']:return json.dumps(network_rows)
            if args[-1]=='/proc/net/route':return kernel
            if args[-1]=='http://127.0.0.1:2019/config/':return '{"owned":"active-proxy"}'
            raise AssertionError(args)
        return before,command,current,private,root,receipt,files,services

    def transition(self,fixture):
        before,command,current,private,root,receipt,files,_services=fixture
        with patch.object(guards,'protected_bytes',side_effect=lambda path:files[Path(path)]):
            return portal.transition_after(before,command,current,private,root,receipt,MIGRATION_MAINTENANCE_BLOCK)

    def test_real_projection_topology_and_owned_proxy_bytes_are_checked_before_commit(self):
        fixture=self.fixture();before=copy.deepcopy(fixture[0])
        after,transition=self.transition(fixture)
        self.assertEqual(set(after),{'api','web','postgres','caddy','portal'})
        self.assertEqual(transition['portal']['container_id'],'e'*64)
        self.assertEqual(transition['caddy_config_ref']['path'],'/private-owned/Caddyfile')
        self.assertEqual(fixture[0],before)

    def test_core_recreation_external_portal_network_profile_or_proxy_drift_stops(self):
        for change in ('postgres','api','portal-edge','private-profile','plan','proxy'):
            fixture=self.fixture();before,_,_,private,_,_,files,services=fixture
            # Freeze the snapshot before altering the observed runtime.
            before['services']=copy.deepcopy(before['services'])
            if change in ('postgres','api'):services[change]['State']['StartedAt']='restarted'
            if change=='portal-edge':services['portal']['NetworkSettings']['Networks']['edge']={'GwPriority':1}
            if change=='private-profile':files[private/'channel.env']=b'EXTERNAL_PROFILE=changed\n'
            if change=='plan':files[private/'daily-b02'/'plan.json']=b'changed'
            if change=='proxy':files[Path('/private-owned/Caddyfile')]+=b'\nforeign.invalid { respond 200 }'
            with self.subTest(change=change),self.assertRaises(ReleaseError):self.transition(fixture)

    def cleanup_fixture(self,change=None):
        before,_,current,_,_,_,_,services=self.fixture()
        row=copy.deepcopy(services['portal']);row['State'].update(Running=False)
        row['Mounts']=[{'Type':'bind','Source':str(guards.PORTAL_BASE/'state'),'Destination':'/data'}]
        if change=='running':row['State']['Running']=True
        if change=='foreign-label':row['Config']['Labels']['com.inovaris.source-sha']='f'*40
        if change=='foreign-image':row['Image']='sha256:'+'f'*64
        if change=='foreign-name':row['Name']='/other-owned-container'
        if change=='foreign-mount':row['Mounts'][0]['Source']='/other-state'
        original=[value['Id'] for value in before['services'].values()]
        ids=original+[row['Id']];calls=[]
        def command(args,_root):
            calls.append(args)
            if args[:3]==['docker','ps','-aq']:return ' '.join(ids)
            if args[:2]==['docker','inspect']:return json.dumps([row])
            if args[:2]==['docker','rm']:
                self.assertEqual(args,['docker','rm',row['Id']]);ids.remove(row['Id']);return row['Id']
            raise AssertionError(args)
        return before,current,row,command,calls

    def test_failed_own_stopped_candidate_is_removed_by_id_without_force_or_volumes(self):
        before,current,row,command,calls=self.cleanup_fixture()
        result=portal.remove_stopped_candidate(command,current,'100-1','c'*40,row['Image'],before)
        self.assertTrue(result['own_stopped_container_removed'])
        self.assertTrue(result['state_and_volumes_preserved'])
        self.assertEqual([call for call in calls if call[1]=='rm'],[['docker','rm','e'*64]])

    def test_cleanup_rejects_running_or_foreign_candidate_without_mutation(self):
        for change in ('running','foreign-label','foreign-image','foreign-name','foreign-mount'):
            before,current,row,command,calls=self.cleanup_fixture(change)
            with self.subTest(change=change),self.assertRaises(ReleaseError):
                portal.remove_stopped_candidate(command,current,'100-1','c'*40,'sha256:'+'b'*64,before)
            self.assertFalse(any(call[1]=='rm' for call in calls))

    def test_combined_scope_is_copy_only_and_full_stays_closed(self):
        env=dict(zip(('GCP_PROJECT_ID','GCP_INSTANCE','GCP_ZONE'),COPY_TARGET))
        self.assertEqual(deployment_scope(env|{'COMMERCE_DEPLOY_SCOPE':'portal-copy'}),'portal-copy')
        with self.assertRaisesRegex(ReleaseError,'COPY_FULL_TRANSITION_NOT_APPROVED'):
            deployment_scope(env|{'COMMERCE_DEPLOY_SCOPE':'full'})
        legacy=dict(zip(('GCP_PROJECT_ID','GCP_INSTANCE','GCP_ZONE'),LEGACY_TARGET))
        with self.assertRaisesRegex(ReleaseError,'COPY_PORTAL_TARGET_REQUIRED'):
            deployment_scope(legacy|{'COMMERCE_DEPLOY_SCOPE':'portal-copy'})

    def test_transport_never_accepts_partial_api_web_success_as_portal_completion(self):
        client=api_fixture.load('deploy-ci-client')
        for report in ({'status':'SUCCEEDED','deployment_scope':'api-web'},
                       {'status':'SUCCEEDED','deployment_scope':'portal-copy','api_web_completed_in_same_run':True}):
            with self.assertRaises(ReleaseError):client.validate_requested_scope(report,'portal-copy')
        report={'status':'SUCCEEDED','deployment_scope':'portal-copy','api_web_completed_in_same_run':True,
                'portal_https_verified':True,'private_pdfs_verified':10,'core_pdfs':9,'consumers_absent':True,'consumers_started':False}
        self.assertTrue(client.validate_requested_scope(report,'portal-copy'))


if __name__=='__main__':unittest.main()
