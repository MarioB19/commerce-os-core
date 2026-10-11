import copy
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import api_web_deployment as guards
from ci_release import ReleaseError
from test_api_web_deployment import vps


class CopyPortalStateTests(unittest.TestCase):
    private = Path('/opt/commerce-os/private')

    def reference(self, path):
        return {'path': str(path), 'bytes': 100, 'sha256': 'a' * 64}

    def portal(self):
        return {'run_id': '100-1', 'source_sha': 'c' * 40,
                'container_id': 'e' * 64, 'image': 'sha256:' + 'b' * 64,
                'proxy_network': 'owned-proxy',
                'report_ref': self.reference('/opt/mcl-portal/current.json'),
                'runtime_env_ref': self.reference('/opt/mcl-portal/releases/100-1/runtime.env'),
                'manifest_ref': self.reference('/opt/commerce-os/releases/portal-100-1/portal-manifest.json')}

    def state(self, portal=False):
        value = {'schema_version': 1, 'status': 'ADOPTED_EXISTING_API_WEB', 'scope': 'api-web',
                 'backup_source_sha': guards.SOURCE_SHA, 'current_release': '/opt/commerce-os/releases/current',
                 'smtp_transition_ref': self.reference('/private/smtp'),
                 'canonical_files': {name: self.reference(self.private / name) for name in guards.FILES},
                 'preserved_runtime': {key * 64: 'a' * 64 for key in 'abcd'},
                 'b02_plan_sha256': 'a' * 64, 'network_baseline': {'core': {}, 'proxy': {}, 'edge': {}},
                 'active_proxy_sha256': 'a' * 64, 'caddy_config_ref': self.reference('/private/Caddyfile'),
                 'policy_version': 93, 'firewall_rule_count': 9}
        if portal:
            value.update(schema_version=2, portal=self.portal())
            value['preserved_runtime']['e' * 64] = 'a' * 64
        return value

    def rows(self):
        state = {'Running': True, 'Paused': False, 'Restarting': False, 'StartedAt': 'same', 'Pid': 1}
        rows = [{'Id': key * 64, 'Image': 'sha256:' + 'b' * 64,
                 'Config': {'Labels': {'com.docker.compose.project': 'commerce-os',
                                       'com.docker.compose.service': name}},
                 'State': copy.deepcopy(state), 'HostConfig': {}, 'Mounts': [], 'NetworkSettings': {}}
                for key, name in zip('abcd', ('api', 'web', 'postgres', 'caddy'))]
        rows[-1]['Config']['Labels'] = {}
        rows.append({'Id': 'e' * 64, 'Image': self.portal()['image'], 'Name': '/mcl-portal-100-1',
                     'Config': {'Labels': {'com.inovaris.product': 'mi-ciclo-listo-portal',
                                           'com.inovaris.source-sha': 'c' * 40}},
                     'State': copy.deepcopy(state), 'HostConfig': {}, 'Mounts': [], 'NetworkSettings': {}})
        return rows

    def inventory(self, rows, portal):
        def command(args, _root):
            return ' '.join(row['Id'] for row in rows) if args[1] == 'ps' else json.dumps(rows)
        return guards.inventory(command, Path('/release'), portal)

    def test_v1_remains_four_and_only_explicit_v2_accepts_bound_portal(self):
        self.assertEqual(guards.validate_state(self.state(), self.private)['schema_version'], 1)
        self.assertEqual(guards.validate_state(self.state(True), self.private)['schema_version'], 2)
        v1 = self.state(); v1['preserved_runtime']['e' * 64] = 'a' * 64
        with self.assertRaises(ReleaseError): guards.validate_state(v1, self.private)
        rows = self.rows()
        with self.assertRaisesRegex(ReleaseError, 'COPY_FOUR_RUNTIME_REQUIRED'): self.inventory(rows, None)
        result = self.inventory(rows, self.portal())
        self.assertEqual(set(result), {'api', 'web', 'postgres', 'caddy', 'portal'})

    def test_v2_identity_paths_closed_fields_and_four_runtime_cannot_be_fabricated(self):
        for change in ('missing-portal', 'wrong-schema', 'bool-schema', 'extra-field', 'wrong-report',
                       'other-runtime', 'manifest-escape', 'unknown-field', 'unsafe-network'):
            value = self.state(True)
            if change == 'missing-portal': del value['portal']
            if change == 'wrong-schema': value['schema_version'] = 3
            if change == 'bool-schema': value['schema_version'] = True
            if change == 'extra-field': value['unpause'] = True
            if change == 'wrong-report': value['portal']['report_ref']['path'] = '/tmp/current.json'
            if change == 'other-runtime': del value['preserved_runtime']['e' * 64]
            if change == 'manifest-escape': value['portal']['manifest_ref']['path'] = '/tmp/portal-manifest.json'
            if change == 'unknown-field': value['portal']['grant'] = True
            if change == 'unsafe-network': value['portal']['proxy_network'] = 'host'
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                guards.validate_state(value, self.private)

    def test_wrong_container_image_revision_name_or_stopped_portal_is_rejected(self):
        for change in ('id', 'image', 'revision', 'name', 'stopped', 'extra', 'restarting'):
            rows = self.rows(); row = rows[-1]
            if change == 'id': row['Id'] = 'f' * 64
            if change == 'image': row['Image'] = 'sha256:' + 'f' * 64
            if change == 'revision': row['Config']['Labels']['com.inovaris.source-sha'] = 'f' * 40
            if change == 'name': row['Name'] = '/mcl-portal-101-1'
            if change == 'stopped': row['State']['Running'] = False
            if change == 'extra': rows.append(copy.deepcopy(rows[0]))
            if change == 'restarting': row['State']['Restarting'] = True
            with self.subTest(change=change), self.assertRaises(ReleaseError):
                self.inventory(rows, self.portal())

    def test_future_api_web_cannot_recreate_or_change_portal(self):
        old = self.inventory(self.rows(), self.portal())
        for field, delta in (('Image', 'sha256:' + 'f' * 64), ('Config', {'Env': ['SECRET=changed']}),
                             ('Mounts', [{'Source': '/other'}]), ('NetworkSettings', {'Networks': {'edge': {}}})):
            after = copy.deepcopy(old); after['portal'][field] = delta
            command = Mock()
            with self.subTest(field=field), self.assertRaisesRegex(ReleaseError, 'COPY_PRESERVED_RUNTIME_CHANGED'):
                guards.compare_after({'services': old}, after, command, Path('/release'), self.private)
            command.assert_not_called()

    def test_portal_public_check_uses_portal_release_and_no_credentials(self):
        expected = {'release': 'c' * 40, 'activities': 480, 'grades': 9,
                    'core_pdfs': 9, 'calendar_in_portal': False}
        class Response(io.BytesIO):
            status = 200
        opener = Mock(side_effect=lambda *args, **kwargs: Response(json.dumps(expected).encode()))
        self.assertTrue(vps.verify_ciclo_state({'portal': self.portal()}, opener))
        self.assertEqual(opener.call_args.args, ('https://ciclo.inovaris.online/api/version',))
        self.assertEqual(opener.call_args.kwargs, {'timeout': 30})
        expected['release'] = 'a' * 40
        with self.assertRaisesRegex(ReleaseError, 'COPY_PORTAL_HTTPS_VERSION_CHANGED'):
            vps.verify_ciclo_state({'portal': self.portal()}, opener)

    def test_ciclo_maintenance_remains_required_without_portal_receipt(self):
        with patch.object(vps, 'verify_ciclo_maintenance', return_value=True) as maintenance:
            self.assertTrue(vps.verify_ciclo_state({}))
            maintenance.assert_called_once_with(None)

    def test_private_ten_pdf_manifest_and_bound_portal_env_and_report_are_read_back(self):
        from mcl_portal_release import portal_env
        portal=self.portal()
        raw_input='MCL_SESSION_SECRET='+'1'*64+'\nMCL_CORE_CODES_SHA256='+'2'*64+'\nMCL_KIT_CODES_SHA256='+'3'*64+'\nNEXT_PUBLIC_SITE_URL=https://ciclo.inovaris.online\n'
        runtime=portal_env(raw_input,'c'*40).encode()
        manifest=json.dumps({'source_sha':'c'*40,'origin':'https://ciclo.inovaris.online',
            'pdfs':{str(index)+'.pdf':'a'*64 for index in range(10)}}).encode()
        report={'status':'ORIGIN_READY','run_id':'100-1','source_sha':'c'*40,'container':'mcl-portal-100-1',
                'image':portal['image'],'proxy_network':'owned-proxy','private_pdfs_verified':10,
                'other_containers_preserved':True,'portal_manifest_sha256':hashlib.sha256(manifest).hexdigest()}
        values={Path(portal['runtime_env_ref']['path']):runtime,Path(portal['manifest_ref']['path']):manifest,
                Path(portal['report_ref']['path']):json.dumps(report).encode()}
        for field in ('report_ref','runtime_env_ref','manifest_ref'):
            path=Path(portal[field]['path']);portal[field]=guards.reference(path,values[path])
        with patch.object(guards,'protected_bytes',side_effect=lambda path:values[Path(path)]):
            self.assertEqual(guards.read_portal_references(portal),runtime)
            # A private calendar PDF is sealed too, while public version still
            # requires exactly nine Core downloads and calendar_in_portal=false.
            values[Path(portal['runtime_env_ref']['path'])]=runtime.replace(b'c'*40,b'f'*40)
            with self.assertRaisesRegex(ReleaseError,'COPY_REFERENCE_CHANGED'):
                guards.read_portal_references(portal)


if __name__ == '__main__': unittest.main()
