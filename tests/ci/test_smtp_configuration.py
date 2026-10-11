import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('smtp_prepare', Path(__file__).resolve().parents[2] / 'scripts' / 'prepare-smtp-vps.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SmtpConfiguration(unittest.TestCase):
    def test_closed_relay_and_explicit_clients(self):
        config, senders = module.render('mail.example.invalid', '172.30.0.1', ['172.30.0.10'], 'security@example.invalid')
        self.assertIn('mynetworks = 172.30.0.10/32', config)
        self.assertIn('smtpd_relay_restrictions = permit_mynetworks, reject', config)
        self.assertIn('milter_default_action = tempfail', config)
        self.assertIn('maximal_queue_lifetime = 5m', config)
        self.assertEqual(senders, 'security@example.invalid OK\n')
        self.assertNotIn('0.0.0.0', config)

    def test_refuses_public_wildcard_cidr_and_injection(self):
        for binding, clients, hostname in [('0.0.0.0', ['172.30.0.10'], 'mail.example.invalid'), ('8.8.8.8', ['172.30.0.10'], 'mail.example.invalid'), ('172.30.0.1', ['172.30.0.0/16'], 'mail.example.invalid'), ('172.30.0.1', [], 'mail.example.invalid'), ('172.30.0.1', ['172.30.0.10'], 'mail.example.invalid\nmynetworks=0.0.0.0/0')]:
            with self.assertRaises(ValueError):
                module.render(hostname, binding, clients, 'security@example.invalid')
