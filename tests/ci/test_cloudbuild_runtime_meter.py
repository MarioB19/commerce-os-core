import copy
import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import socket
import threading
import time
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from cloudbuild_admission import AdmissionError, CASConflict, CommitOutcomeUnknown
from cloudbuild_runtime_meter import RuntimeMeter, initial_document, usage, validate


class Store:
    def __init__(self, document=None):
        self.document = copy.deepcopy(document)
        self.generation = '1' if document is not None else '0'
        self.failure = None
        self.writes = 0

    def load(self):
        return self.generation, copy.deepcopy(self.document)

    def compare_and_swap(self, expected, document):
        if expected != self.generation or self.failure == 'conflict':
            raise CASConflict('TEST_CAS_CONFLICT')
        self.document = copy.deepcopy(document)
        self.generation = str(int(self.generation) + 1)
        self.writes += 1
        if self.failure == 'unknown':
            raise CommitOutcomeUnknown('TEST_CAS_UNKNOWN')
        return self.generation


class MeterTests(unittest.TestCase):
    def setUp(self):
        self.time = datetime(2026, 10, 11, 16, tzinfo=timezone.utc)
        self.store = Store(initial_document())
        self.meter = RuntimeMeter(self.store, clock=lambda: self.time)

    def reserve(self, seconds=5):
        return self.meter.reserve(str(uuid.uuid4()), seconds)

    def test_missing_does_not_bootstrap(self):
        store = Store()
        with self.assertRaisesRegex(AdmissionError, 'MISSING_NO_RESET'):
            RuntimeMeter(store).reserve(str(uuid.uuid4()))
        self.assertEqual(store.writes, 0)

    def test_completion_retains_entire_reservation(self):
        reservation = self.reserve()
        reservation = self.meter.extend(reservation, 120)
        self.meter.finish(reservation, {'status': 'CONFIRMED'})
        self.assertIsNone(self.store.document['active_request'])
        self.assertEqual(usage(self.store.document)['2026-10'],
                         {'requests': 1, 'cpu_ms': 120000, 'memory_mib_ms': 245760000})

    def test_duplicate_concurrent_request_is_rejected(self):
        reservation = self.reserve()
        with self.assertRaisesRegex(AdmissionError, 'PREVIOUS_REQUEST_UNRESOLVED'):
            self.reserve()
        self.meter.finish(reservation, {'ok': True})
        with self.assertRaisesRegex(AdmissionError, 'ALREADY_RESERVED'):
            self.meter.reserve(reservation['request_id'])

    def test_unknown_cas_preserves_reservation_and_blocks_another_effect(self):
        self.store.failure = 'unknown'
        with self.assertRaises(CommitOutcomeUnknown):
            self.reserve()
        self.store.failure = None
        with self.assertRaisesRegex(AdmissionError, 'UNRESOLVED'):
            self.reserve()

    def test_explicit_unknown_never_expires_or_refunds(self):
        reservation = self.reserve()
        self.meter.finish(reservation, {'error': 'UNKNOWN'}, unknown=True)
        self.time += timedelta(days=31)
        with self.assertRaisesRegex(AdmissionError, 'UNRESOLVED'):
            self.reserve()
        self.assertEqual(usage(self.store.document)['2026-10']['cpu_ms'], 5000)

    def test_month_boundary_charges_both_months_without_reset(self):
        self.time = datetime(2026, 10, 31, 23, 59, 58, tzinfo=timezone.utc)
        reservation = self.reserve()
        self.meter.finish(reservation, {'ok': True})
        totals = usage(self.store.document)
        self.assertEqual(totals['2026-10'], totals['2026-11'])

    def test_enlargement_can_add_second_month(self):
        self.time = datetime(2026, 10, 31, 23, 59, tzinfo=timezone.utc)
        reservation = self.reserve()
        self.assertEqual(set(usage(self.store.document)), {'2026-10'})
        self.meter.extend(reservation, 120)
        self.assertEqual(set(usage(self.store.document)), {'2026-10', '2026-11'})

    def test_expired_reservation_cannot_be_extended_or_completed(self):
        reservation = self.reserve()
        self.time += timedelta(seconds=6)
        for operation in (lambda: self.meter.extend(reservation, 120),
                          lambda: self.meter.finish(reservation, {'ok': True})):
            with self.assertRaisesRegex(AdmissionError, 'WINDOW_EXPIRED'):
                operation()
        self.assertEqual(self.store.document['active_request'], reservation['request_id'])

    def test_ceiling_not_credits_controls_admission(self):
        for _ in range(44):
            reservation = self.reserve(450)
            self.meter.finish(reservation, {'ok': True})
        before = copy.deepcopy(self.store.document)
        with self.assertRaisesRegex(AdmissionError, 'MONTHLY_CEILING'):
            self.reserve(450)
        self.assertEqual(self.store.document, before)

    def test_conflict_never_retries_cas(self):
        self.store.failure = 'conflict'
        with self.assertRaises(CASConflict):
            self.reserve()
        self.assertEqual(self.store.writes, 0)

    def test_tampered_handle_and_shrink_fail(self):
        reservation = self.reserve(120)
        for changed in (dict(reservation, ceiling_ms=5000),
                        dict(reservation, request_id=str(uuid.uuid4()))):
            with self.assertRaises(AdmissionError):
                self.meter.finish(changed, {'ok': True})
        with self.assertRaisesRegex(AdmissionError, 'CANNOT_SHRINK'):
            self.meter.extend(reservation, 5)

    def test_invalid_state_and_future_clock_fail(self):
        reservation = self.reserve()
        self.meter.finish(reservation, {'ok': True})
        self.time -= timedelta(seconds=1)
        with self.assertRaisesRegex(AdmissionError, 'CLOCK_REVERSED'):
            self.reserve()
        bad = copy.deepcopy(self.store.document)
        bad['requests'][reservation['request_id']]['months'] = ['2026-11']
        with self.assertRaises(AdmissionError):
            validate(bad)


HTTP_PATH = Path(__file__).resolve().parents[2] / 'scripts' / 'cloudbuild-http.py'
spec = importlib.util.spec_from_file_location('controller_http_test', HTTP_PATH)
http = importlib.util.module_from_spec(spec)
spec.loader.exec_module(http)


class Work:
    operation = 'DISPATCH_FULL'
    reservation_seconds = 450


class Factory:
    def __init__(self):
        self.meter_store = Store(initial_document())
        self.work = Work()
        self.calls = 0
        self.result = {'request_outcome': 'CONFIRMED', 'secret_response': 'must-not-leak'}

    def inspect_work(self):
        return self.work

    def execute(self, _work):
        self.calls += 1
        return self.result


class HTTPTests(unittest.TestCase):
    def request(self, raw):
        server, client = socket.socketpair()
        client.settimeout(1)
        try:
            client.sendall(raw)
            with patch.object(http, 'tick', return_value={'status': 'TEST_TICK'}) as tick_call:
                http.Handler(server, ('127.0.0.1', 1), None)
                response = client.recv(4096)
            return response, tick_call.call_count
        finally:
            server.close()
            client.close()

    def test_real_http_parser_accepts_only_empty_exact_tick(self):
        response, calls = self.request(b'POST /tick HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n')
        self.assertIn(b'200 OK', response)
        self.assertEqual(calls, 1)

    def test_pubsub_body_is_hint_only_and_malformed_hint_is_acknowledged(self):
        body = b'{"operation":"PUBLISH","secret":"must-not-leak"}'
        response, calls = self.request(b'POST /events HTTP/1.1\r\nHost: localhost\r\nContent-Length: '
                                       + str(len(body)).encode() + b'\r\n\r\n' + body)
        self.assertIn(b'200 OK', response)
        self.assertEqual(calls, 1)
        self.assertNotIn(b'must-not-leak', response)
        response, calls = self.request(b'POST /events HTTP/1.1\r\nHost: localhost\r\nContent-Length: 999999\r\n\r\n')
        self.assertIn(b'200 OK', response)
        self.assertIn(b'STOP_INVALID_EVENT_HINT', response)
        self.assertEqual(calls, 0)

    def test_slow_drip_headers_cannot_extend_absolute_parser_deadline(self):
        server, client = socket.socketpair()
        stop = threading.Event()
        def drip():
            try:
                for byte in b'POST /tick HTTP/1.1\r\nHost: localhost\r\n\r\n':
                    if stop.wait(.02):
                        return
                    client.sendall(bytes([byte]))
            except OSError:
                pass
        thread = threading.Thread(target=drip, daemon=True)
        thread.start()
        started = time.monotonic()
        try:
            with patch.object(http, 'PARSER_SECONDS', .15), patch.object(http, 'tick') as tick_call:
                http.Handler(server, ('127.0.0.1', 1), None)
            self.assertLess(time.monotonic() - started, .7)
            tick_call.assert_not_called()
        finally:
            stop.set()
            server.close()
            client.close()
            thread.join(1)

    def test_real_http_parser_rejects_body_query_transfer_and_duplicate_lengths(self):
        for raw in (
            b'POST /tick?operation=PUBLISH HTTP/1.1\r\nHost: localhost\r\n\r\n',
            b'POST /tick HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\n\r\n{}',
            b'POST /tick HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
            b'POST /tick HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n',
            b'GET /tick HTTP/1.1\r\nHost: localhost\r\n\r\n',
        ):
            with self.subTest(request=raw):
                response, calls = self.request(raw)
                self.assertNotIn(b'200 OK', response)
                self.assertEqual(calls, 0)

    def test_release_work_requires_full_450_second_reservation(self):
        for operation in ('SOURCE', 'DISPATCH_FULL', 'ATTEST', 'PACKAGE', 'PUBLISH'):
            for seconds in (120, 450):
                factory = Factory(); factory.work.operation = operation; factory.work.reservation_seconds = seconds
                result = http.tick(lambda: factory)
                self.assertEqual(result['status'], 'TICK_RECORDED' if seconds == 450 else 'STOP_PRESERVE')
                self.assertEqual(factory.calls, 1 if seconds == 450 else 0)
                if seconds == 450:
                    self.assertEqual(usage(factory.meter_store.document)['2026-10']['cpu_ms'], 450000)

    def test_dispatch_is_metered_and_response_does_not_expose_result(self):
        factory = Factory()
        result = http.tick(lambda: factory)
        self.assertEqual(result['status'], 'TICK_RECORDED')
        self.assertEqual(factory.calls, 1)
        self.assertNotIn('must-not-leak', str(result))
        self.assertEqual(next(iter(usage(factory.meter_store.document).values()))['cpu_ms'], 450000)

    def test_idle_keeps_reservation_and_does_not_execute(self):
        factory = Factory()
        factory.work = None
        self.assertEqual(http.tick(lambda: factory)['status'], 'TICK_RECORDED')
        self.assertEqual(factory.calls, 0)

    def test_unknown_reservation_cas_cannot_execute(self):
        factory = Factory()
        factory.meter_store.failure = 'unknown'
        result = http.tick(lambda: factory)
        self.assertEqual(result['status'], 'STOP_PRESERVE')
        self.assertTrue(result['reservation_may_exist'])
        self.assertEqual(factory.calls, 0)
        self.assertIsNotNone(factory.meter_store.document['active_request'])

    def test_unknown_effect_retains_active_request(self):
        factory = Factory()
        factory.result = {'request_outcome': 'UNKNOWN'}
        self.assertEqual(http.tick(lambda: factory)['status'], 'STOP_PRESERVE')
        self.assertIsNotNone(factory.meter_store.document['active_request'])
        self.assertEqual(http.tick(lambda: factory)['status'], 'STOP_PRESERVE')
        self.assertEqual(factory.calls, 1)

    def test_untrusted_operation_is_not_called(self):
        factory = Factory()
        factory.work.operation = 'SHELL'
        self.assertEqual(http.tick(lambda: factory)['status'], 'STOP_PRESERVE')
        self.assertEqual(factory.calls, 0)

    def test_timeout_preserves_exclusion_without_followup_write(self):
        factory = Factory()
        with patch.object(factory, 'execute', side_effect=http.Deadline('CONTROLLER_REQUEST_DEADLINE')):
            result = http.tick(lambda: factory)
        self.assertEqual(result['code'], 'CONTROLLER_REQUEST_DEADLINE')
        self.assertIsNotNone(factory.meter_store.document['active_request'])

    def test_uppercase_exception_content_never_reaches_response(self):
        factory = Factory()
        with patch.object(factory, 'execute', side_effect=RuntimeError('SECRET_VALUE_ABC')):
            result = http.tick(lambda: factory)
        self.assertEqual(result['code'], 'CONTROLLER_REQUEST_FAILED')
        self.assertNotIn('SECRET_VALUE_ABC', str(result))


if __name__ == '__main__':
    unittest.main()
