"""Measure uses only observed gateways; no Docker or API effects in these tests."""
import copy
import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('capacity_measure', ROOT/'scripts/number-capacity-administrator.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def gateway(slot=1):
    service = f'waha-{slot:02}'
    return {'Id':f'{slot:064x}', 'Name':f'/commerce-os-{service}-1',
            'Config':{'Labels':{'com.docker.compose.project':'commerce-os', 'com.docker.compose.service':service}},
            'Image':'sha256:'+'b'*64, 'State':{'Running':True},
            'Mounts':[{'Destination':target, 'Name':f'commerce-os_{service}-{suffix}'}
                      for target,suffix in [('/app/.sessions','sessions'),('/app/.media','media')]],
            'NetworkSettings':{'Networks':{f'commerce-os_gateway-{slot:02}':{}}}}


class MeasureTests(unittest.TestCase):
    def setUp(self):
        self.agent = mod.Administrator.__new__(mod.Administrator)
        self.agent.directory = Path('/synthetic/private')
        self.agent.credentials = lambda *args, **kwargs: {'WAHA_API_KEY':'synthetic'}
        self.agent.provisioning_overlay_digest = lambda: 'c'*64
        self.services = {'api','waha-01'}
        self.containers = [gateway()]
        self.calls = []
        self.writes = []
        self.agent.compose = self.compose
        self.agent.api = self.api
        self.patch = patch.object(mod, 'run', side_effect=self.command)
        self.patch.start(); self.addCleanup(self.patch.stop)

    def compose(self, *args):
        self.calls.append(('compose', *args))
        if args == ('config','--services'):
            return '\n'.join(sorted(self.services))+'\n'
        self.assertEqual(args[:3], ('ps','--all','-q'))
        service = args[3]
        # Docker Compose rejects an unknown service before producing a ps list.
        if service not in self.services:
            raise RuntimeError('BOUNDED_HOST_COMMAND_FAILED')
        return '\n'.join(row['Id'] for row in self.containers
                         if row['Config']['Labels'].get('com.docker.compose.project')=='commerce-os'
                         and row['Config']['Labels'].get('com.docker.compose.service')==service)

    def command(self, args, **kwargs):
        self.calls.append(tuple(args))
        if args == ['docker','ps','--all','--quiet','--no-trunc']:
            return '\n'.join(row['Id'] for row in self.containers)
        if args[:2] == ['docker','inspect']:
            return json.dumps([copy.deepcopy(row) for row in self.containers if row['Id'] in args[2:]])
        if args[:3] == ['docker','exec','-i']:
            return json.dumps({'count':0,'connected':0})
        if args[:2] == ['docker','stats']:
            return json.dumps({'MemUsage':'128MiB / 768MiB'})
        self.fail(f'Unexpected command: {args[:3]}')

    def api(self, path, body=None):
        if body is None:
            self.assertEqual(path, '/number-capacity?limit=100')
            return {'slots':[{'slot':slot} for slot in (1,2,3)]}
        self.writes.append((path,body)); return {'accepted':True}

    def measure(self):
        def read(path):
            if str(path)=='/proc/meminfo': return 'MemTotal: 8000000 kB\nMemAvailable: 6000000 kB\n'
            if str(path)=='/proc/stat': return 'cpu 1 0 1 100 0 0 0 0\n'
            raise AssertionError(str(path))
        with patch.object(Path,'read_text',read), patch.object(mod.time,'sleep'), \
             patch.object(mod.os,'cpu_count',return_value=4), \
             patch.object(mod.os,'statvfs',return_value=types.SimpleNamespace(f_bavail=1000, f_frsize=4096)):
            return self.agent.measure()

    def test_measure_single_pilot_skips_only_proven_absent_slots(self):
        self.assertEqual(self.measure(), {'accepted':True})
        self.assertEqual([path for path,_ in self.writes], ['/number-capacity/inventory','/number-capacity/measurements'])
        self.assertEqual([row['slot'] for row in self.writes[0][1]['slots']], [1])
        self.assertEqual(self.writes[1][1]['metrics']['gateway_count'],1)
        self.assertEqual(self.writes[1][1]['metrics']['measured_gateway_memory_bytes'],128*1024**2)
        self.assertFalse(any(call[:4]==('compose','ps','--all','-q') and call[4] in ('waha-02','waha-03') for call in self.calls))

    def test_configured_but_not_created_slot_is_absent(self):
        self.services.add('waha-02')
        with self.assertRaisesRegex(ValueError,'GATEWAY_NOT_PROVISIONED'): self.agent.snapshot(2)

    def test_empty_host_confirms_absence(self):
        self.containers=[]
        with self.assertRaisesRegex(ValueError,'GATEWAY_NOT_PROVISIONED'): self.agent.snapshot(2)
        self.assertFalse(any(call[:2]==('docker','inspect') for call in self.calls))

    def test_two_configured_gateways_are_both_measured(self):
        self.services.add('waha-02'); self.containers.append(gateway(2))
        self.measure()
        self.assertEqual([row['slot'] for row in self.writes[0][1]['slots']], [1,2])
        self.assertEqual(self.writes[1][1]['metrics']['gateway_count'],2)
        self.assertEqual(self.writes[1][1]['metrics']['measured_gateway_memory_bytes'],256*1024**2)

    def test_stopped_gateway_remains_an_error_without_measurement_writes(self):
        self.containers[0]['State']['Running']=False
        with self.assertRaisesRegex(ValueError,'GATEWAY_STOPPED_READBACK_REQUIRED'): self.measure()
        self.assertEqual(self.writes,[])

    def test_historical_gateway_missing_from_compose_is_not_absent(self):
        for running in (True,False):
            with self.subTest(running=running):
                row=gateway(2); row['State']['Running']=running; self.containers=[gateway(),row]
                with self.assertRaisesRegex(ValueError,'GATEWAY_CONFIGURATION_MISSING'): self.measure()
                self.assertEqual(self.writes,[])

    def test_foreign_project_with_same_service_is_not_absent(self):
        row=gateway(2); row['Config']['Labels']['com.docker.compose.project']='another-project'
        row['Name']='/foreign'; row['Mounts']=[]; self.containers.append(row)
        with self.assertRaisesRegex(ValueError,'GATEWAY_CONFIGURATION_MISSING'): self.agent.snapshot(2)

    def test_named_unlabelled_gateway_is_not_absent(self):
        for name in ('/waha-02','/commerce-os-waha-02-1','/commerce-os_waha-02_1'):
            with self.subTest(name=name):
                row=gateway(2); row['Name']=name; row['Config']['Labels']={}; row['Mounts']=[]
                self.containers=[gateway(),row]
                with self.assertRaisesRegex(ValueError,'GATEWAY_CONFIGURATION_MISSING'): self.agent.snapshot(2)

    def test_foreign_stopped_container_using_slot_volume_is_not_absent(self):
        for suffix in ('sessions','media'):
            with self.subTest(suffix=suffix):
                row=gateway(2); row['Name']='/foreign'; row['Config']['Labels']={}; row['State']['Running']=False
                row['Mounts']=[{'Name':'commerce-os_waha-02-'+suffix}]; self.containers=[gateway(),row]
                with self.assertRaisesRegex(ValueError,'GATEWAY_CONFIGURATION_MISSING'): self.agent.snapshot(2)

    def test_unrelated_container_does_not_provision_slot(self):
        row=gateway(20); self.containers.append(row)
        with self.assertRaisesRegex(ValueError,'GATEWAY_NOT_PROVISIONED'): self.agent.snapshot(2)

    def test_compose_error_is_not_absence(self):
        self.agent.compose=lambda *args: (_ for _ in ()).throw(RuntimeError('BOUNDED_HOST_COMMAND_FAILED'))
        with self.assertRaisesRegex(RuntimeError,'BOUNDED_HOST_COMMAND_FAILED'): self.measure()
        self.assertEqual(self.writes,[])

    def test_docker_error_is_not_absence(self):
        with patch.object(mod,'run',side_effect=RuntimeError('BOUNDED_HOST_COMMAND_FAILED')):
            with self.assertRaisesRegex(RuntimeError,'BOUNDED_HOST_COMMAND_FAILED'): self.agent.snapshot(2)

    def test_inspect_incomplete_or_duplicate_is_not_absence(self):
        for rows in ([],[gateway(),gateway()]):
            with self.subTest(rows=len(rows)):
                with patch.object(mod,'run',side_effect=lambda args: '1'.zfill(64) if args[1]=='ps' else json.dumps(rows)):
                    with self.assertRaisesRegex(ValueError,'GATEWAY_HOST_INVENTORY_REQUIRED'): self.agent.snapshot(2)

    def test_invalid_or_duplicate_docker_ids_are_not_absence(self):
        for raw in ('not-an-id', '1'*64+'\n'+'1'*64):
            with self.subTest(raw=raw), patch.object(mod,'run',return_value=raw) as command:
                with self.assertRaisesRegex(ValueError,'GATEWAY_HOST_INVENTORY_REQUIRED'): self.agent.snapshot(2)
                self.assertEqual(command.call_count,1)

    def test_empty_or_invalid_compose_inventory_is_not_absence(self):
        for raw in ('','not a service\n','api\napi\n'):
            with self.subTest(raw=raw):
                self.agent.compose=lambda *args:raw
                with self.assertRaisesRegex(ValueError,'GATEWAY_COMPOSE_INVENTORY_REQUIRED'): self.agent.snapshot(2)


if __name__ == '__main__': unittest.main()
