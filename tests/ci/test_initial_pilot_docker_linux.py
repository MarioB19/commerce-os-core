"""Opt-in native Docker guards; synthetic Alpine processes, never WAHA or secrets.

Run as Linux Root in a disposable Docker daemon with no existing containers:
COMMERCE_INITIAL_PILOT_DOCKER_TEST=1 python3 -m unittest discover -s tests/ci \
  -p test_initial_pilot_docker_linux.py
The test only removes resources carrying its fresh ownership label.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('native_initial_pilot', ROOT/'scripts/initial-pilot-root.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)


@unittest.skipUnless(os.environ.get('COMMERCE_INITIAL_PILOT_DOCKER_TEST') == '1', 'requires isolated Linux Docker opt-in')
class NativePilotDocker(unittest.TestCase):
    def test_created_start_network_and_owned_empty_volumes(self):
        self.assertEqual(sys.platform, 'linux'); self.assertEqual(os.geteuid(), 0)
        token = uuid.uuid4().hex
        label = 'com.inovaris.test-owner'
        def command(args):
            return subprocess.run(args, text=True, capture_output=True, check=True, timeout=90).stdout.strip()
        def docker(*args): return command(['docker', *args])
        def inspect(*ids): return json.loads(docker('inspect', *ids))
        self.assertEqual(docker('ps', '-aq'), '', 'use a disposable daemon without existing containers')
        networks = {'core':'commerce-os_core', 'proxy':'capacity-native-proxy',
                    'edge':'capacity-native-edge', 'consumer':'capacity-native-consumer', 'gateway-01':'commerce-os_gateway-01'}
        present = set(docker('network','ls','--format','{{.Name}}').splitlines())
        self.assertFalse(present & set(networks.values()))
        volume_before = m.volume_snapshot(ROOT)
        self.assertEqual(volume_before['volumes'], [])
        image = json.loads(docker('image','inspect','alpine:3.23'))[0]
        pinned = image['RepoDigests'][0]
        services = {}
        memberships = {'postgres':['core'],'web':['proxy'],'api':['core','proxy','edge'],
            'caddy':['proxy','edge'],'portal':['proxy'],'ingress':['core','proxy'],
            'automation-worker':['core','consumer'],'channel-worker':['core']}
        for name, membership in memberships.items():
            services[name] = {'image':pinned, 'command':['sleep','300'], 'restart':'no',
                'container_name':'capacity-native-'+name+'-'+token[:8], 'mem_limit':'32m', 'cpus':0.05,
                'labels':{label:token}, 'networks':{network:{} for network in membership}}
            if name in {'api','ingress','automation-worker','channel-worker'}:
                services[name]['sysctls'] = {'net.ipv4.ip_forward':'0','net.ipv6.conf.all.forwarding':'0'}
        services['api']['networks']['edge'] = {'gw_priority':1}
        services['automation-worker']['networks']['consumer'] = {'gw_priority':1}
        run_id = '123456789-1'
        services['portal']['container_name'] = 'mcl-portal-'+run_id
        services['portal']['labels'].update({'com.inovaris.product':'mi-ciclo-listo-portal','com.inovaris.source-sha':'a'*40})
        services['waha-01'] = {'image':pinned,'command':['sleep','300'],'restart':'no','init':True,
            'container_name':'capacity-native-gateway-'+token[:8], 'profiles':['native-fixture'],
            'labels':{label:token},'cap_drop':['ALL'],'pids_limit':100,'mem_limit':'768m','cpus':0.3,
            'security_opt':['no-new-privileges:true'], 'networks':{'gateway-01':{}},
            'environment':{'WHATSAPP_DEFAULT_ENGINE':'GOWS','WAHA_PRINT_QR':'false',
                'WAHA_DASHBOARD_ENABLED':'false','WHATSAPP_SWAGGER_ENABLED':'false',
                'WHATSAPP_RESTART_ALL_SESSIONS':'false','WAHA_WORKER_RESTART_SESSIONS':'false',
                'WHATSAPP_START_SESSION':'','WAHA_APPS_ENABLED':'false'},
            'volumes':['waha-01-sessions:/app/.sessions','waha-01-media:/app/.media']}
        definition = {'name':'commerce-os','services':services,
            'networks':{key:{'name':name,'internal':key in {'core','proxy'},'labels':{label:token}} for key,name in networks.items()},
            'volumes':{name.removeprefix('commerce-os_'):{'name':name,'labels':{label:token}} for name in m.VOLUMES}}
        release = {'COMMERCE_PROXY_NETWORK':networks['proxy'],'COMMERCE_API_EDGE_NETWORK':networks['edge'],
                   'COMMERCE_CONSUMER_EDGE_NETWORK':networks['consumer']}
        with tempfile.TemporaryDirectory(prefix='capacity-native-') as tmp:
            compose_file = Path(tmp)/'compose.json'; compose_file.write_text(json.dumps(definition))
            def compose(*args): return command(['docker','compose','-f',str(compose_file),'--profile','native-fixture',*args])
            try:
                rendered = compose('config','--format','json')
                m.rendered_guard(rendered.encode(),pinned)
                compose('up','--pull','never','--no-deps','-d',*memberships)
                core_rows = inspect(*docker('ps','-aq').split())
                by_name = {row['Config']['Labels']['com.docker.compose.service']:row for row in core_rows}
                portal = {'container_id':by_name['portal']['Id'],'image':by_name['portal']['Image'],
                    'source_sha':'a'*40,'run_id':run_id,'proxy_network':networks['proxy'],
                    'report_ref':{'path':'/opt/mcl-portal/current.json','bytes':1,'sha256':'a'*64},
                    'runtime_env_ref':{'path':'/opt/mcl-portal/releases/'+run_id+'/runtime.env','bytes':1,'sha256':'a'*64},
                    'manifest_ref':{'path':'/opt/commerce-os/releases/synthetic/portal-manifest.json','bytes':1,'sha256':'a'*64}}
                state = {'portal':portal,'service_inventory':{key:row['Id'] for key,row in by_name.items()}}
                m.runtime.inspect_inventory(core_rows,portal=portal,caddy_id=by_name['caddy']['Id'])
                network_rows = json.loads(docker('network','inspect',*(networks[key] for key in ('core','proxy','edge','consumer'))))
                state['network_baseline'] = {row['Name']:{key:row[key] for key in ('Name','Id','Driver','Internal','EnableIPv6','IPAM','Options','Labels')} for row in network_rows}
                self.assertEqual(m.volume_snapshot(ROOT),volume_before)
                compose('create','--no-build','--no-recreate','--pull','never','waha-01')
                gateway_id = compose('ps','-aq','waha-01')
                created = inspect(gateway_id)[0]
                m.gateway_guard(created,image['Id'])
                self.assertFalse(created['State']['Running']); self.assertEqual(created['State']['Pid'],0)
                self.assertEqual(created['NetworkSettings']['Networks'][networks['gateway-01']]['NetworkID'],'')
                created_volumes = m.volume_snapshot(ROOT)
                m.empty_owned_volumes(created_volumes['volumes'])
                self.assertEqual(set(created_volumes['names']),set(volume_before['names'])|set(m.VOLUMES))
                for name in ('ingress','channel-worker'):docker('network','connect',networks['gateway-01'],by_name[name]['Id'])
                prepared = m.read_services(ROOT,state)
                m.preserved(by_name,prepared)
                sealed_networks = m.network_guard(ROOT,state,prepared,release)
                identity = copy.deepcopy(m.gateway_identity(created))
                self.assertEqual(m.network_guard(ROOT,state,m.read_services(ROOT,state),release),sealed_networks)
                docker('start',gateway_id)
                started = m.read_services(ROOT,state)
                m.gateway_guard(started['waha-01'],image['Id'])
                self.assertTrue(started['waha-01']['State']['Running'])
                self.assertGreater(started['waha-01']['State']['Pid'],0)
                self.assertEqual(started['waha-01']['NetworkSettings']['Networks'][networks['gateway-01']]['NetworkID'],sealed_networks[networks['gateway-01']]['Id'])
                actual_identity=m.gateway_identity(started['waha-01'])
                differences={key:[field for field in set(identity[key])|set(actual_identity[key]) if identity[key].get(field)!=actual_identity[key].get(field)]
                    if type(identity[key]) is dict else 'changed' for key in identity if identity[key]!=actual_identity[key]}
                self.assertEqual(differences,{})
                self.assertEqual(m.network_guard(ROOT,state,started,release),sealed_networks)
                m.runtime.compare_live_snapshot({name:row for name,row in prepared.items() if name!='waha-01'},
                    {name:row for name,row in started.items() if name!='waha-01'})
                self.assertEqual(m.volume_snapshot(ROOT),created_volumes)
                m.empty_owned_volumes(created_volumes['volumes'])
                # Reject actual foreign endpoint ownership before any subsequent start.
                outsider=docker('run','-d','--network',networks['gateway-01'],'--label',label+'='+token,pinned,'sleep','30')
                with self.assertRaisesRegex(Exception,'NETWORK_FOREIGN_ENDPOINT'):
                    m.network_guard(ROOT,state,started,release)
                docker('rm','-f',outsider)
                # A real write in the owned volume cannot pass an empty-volume claim.
                marker=Path(created_volumes['volumes'][0]['Mountpoint'])/'synthetic-test-marker'
                marker.write_text('synthetic fixture only')
                with self.assertRaisesRegex(Exception,'CREATED_VOLUME_NOT_EMPTY'):m.empty_owned_volumes(created_volumes['volumes'])
                marker.unlink()
                self.assertEqual(m.volume_snapshot(ROOT),created_volumes)
            finally:
                for cid in docker('ps','-aq','--filter','label='+label+'='+token).split():docker('rm','-f',cid)
                for nid in docker('network','ls','-q','--filter','label='+label+'='+token).split():docker('network','rm',nid)
                for vid in docker('volume','ls','-q','--filter','label='+label+'='+token).split():docker('volume','rm',vid)
            self.assertEqual(docker('ps','-aq'),'')
            self.assertEqual(m.volume_snapshot(ROOT),volume_before)


if __name__ == '__main__':unittest.main()
