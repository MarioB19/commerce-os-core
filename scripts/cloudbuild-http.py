#!/usr/bin/env python3
"""Fixed authenticated Cloud Run entrypoint; native IAM must protect /tick.

There is no workflow, URL, callback, config path or credential in the request.
The trusted factory and control object choose work. Pub/Sub bodies on /events
are bounded hints and are discarded. HTTP 200 acknowledges a
rejected hint without creating a Pub/Sub retry storm; it never means a gate PASS.
"""
import json
import os
import re
import signal
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

if __name__ == '__main__':
    installed = Path('/opt/trusted/cloudbuild-http.py')
    if Path(__file__) != installed or installed.is_symlink():
        raise SystemExit('CONTROLLER_ENTRYPOINT_PATH_REJECTED')
    sys.path.insert(0, '/opt/trusted')

from cloudbuild_runtime_meter import RuntimeMeter
from cloudbuild_diagnostics import evidence_code, phase

PARSER_SECONDS = 3
MAX_HINT_BYTES = 256 * 1024


class Deadline(Exception):
    pass


def safe_error(error):
    code = evidence_code(error)
    if code is not None:
        return code
    return {'Deadline': 'CONTROLLER_REQUEST_DEADLINE',
            'CASConflict': 'CONTROLLER_CAS_CONFLICT',
            'CommitOutcomeUnknown': 'CONTROLLER_CAS_UNCONFIRMED',
            'AdmissionError': 'CONTROLLER_ADMISSION_STOP'}.get(type(error).__name__,
                                                             'CONTROLLER_REQUEST_FAILED')


def tick(factory_builder, *, started=None):
    """Dependency injection is internal for tests; the HTTP route supplies none."""
    started = time.monotonic() if started is None else started
    reservation = None
    factory = None
    diagnostic_phase = 'FACTORY_INITIALIZE'
    reservation_attempted = False
    previous = signal.getsignal(signal.SIGALRM)

    def expired(_signal, _frame):
        raise Deadline('CONTROLLER_REQUEST_DEADLINE')

    def deadline(seconds):
        remaining = started + seconds - time.monotonic()
        if remaining <= 0:
            raise Deadline('CONTROLLER_REQUEST_DEADLINE')
        signal.setitimer(signal.ITIMER_REAL, remaining)

    signal.signal(signal.SIGALRM, expired)
    try:
        # Factory/ADC/ledger reads are inside this initial wall-clock ceiling.
        # Native deployment must separately account for pre-process startup.
        deadline(5)
        factory = factory_builder()
        meter = RuntimeMeter(factory.meter_store)
        reservation_attempted = True
        reservation = meter.reserve(str(uuid.uuid4()), 5)
        diagnostic_phase = 'CONTROL_INSPECT'
        work = factory.inspect_work()
        if work is None:
            result = {'status': 'IDLE', 'external_effects': False, 'request_outcome': 'CONFIRMED'}
        else:
            if work.operation not in {'SOURCE', 'DISPATCH_FULL', 'RECONCILE_FULL',
                                      'ATTEST', 'PACKAGE', 'PUBLISH', 'RECONCILE'}:
                raise ValueError('CONTROLLER_WORK_OPERATION_REJECTED')
            seconds = work.reservation_seconds
            if type(seconds) is not int or seconds not in {120, 450}:
                raise ValueError('CONTROLLER_WORK_RESERVATION_REJECTED')
            if (work.operation in {'SOURCE', 'DISPATCH_FULL', 'ATTEST', 'PACKAGE', 'PUBLISH'}) != (seconds == 450):
                raise ValueError('CONTROLLER_WORK_RESERVATION_MISMATCH')
            # A failed or uncertain CAS never reaches execute.
            reservation = meter.extend(reservation, seconds)
            deadline(seconds)
            diagnostic_phase = 'WORK_VALIDATE'
            result = factory.execute(work)
            if type(result) is not dict or result.get('request_outcome') != 'CONFIRMED':
                raise ValueError('CONTROLLER_WORK_RESULT_INVALID')
        diagnostic_phase = 'METER_COMPLETE'
        receipt = meter.finish(reservation, result)
        # Never expose arbitrary factory output or provider response to HTTP.
        return {'status': 'TICK_RECORDED', 'request_id': reservation['request_id'],
                'meter_state': receipt['state'], 'build_success_claimed': False}
    except Exception as error:
        # Do not attempt another write after a deadline/CAS/effect uncertainty.
        # An existing reservation retains both the budget and exclusion. A
        # separate read-only reconciliation must determine the real outcome.
        return {'status': 'STOP_PRESERVE', 'code': safe_error(error),
                'phase': phase(getattr(factory, 'diagnostic_phase', diagnostic_phase)
                               if diagnostic_phase == 'WORK_VALIDATE' else diagnostic_phase),
                'reservation_may_exist': reservation_attempted,
                'automatic_retry': False, 'build_success_claimed': False}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class Handler(BaseHTTPRequestHandler):
    server_version = 'CommerceController'

    def setup(self):
        self.request.settimeout(PARSER_SECONDS)
        super().setup()

    def handle_one_request(self):
        self.request_started = time.monotonic()
        self.parser_previous_handler = signal.getsignal(signal.SIGALRM)
        def expired(_signal, _frame):
            raise Deadline('CONTROLLER_PARSER_DEADLINE')
        signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, PARSER_SECONDS)
        try:
            super().handle_one_request()
        except Deadline:
            self.close_connection = True
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, self.parser_previous_handler)

    def log_message(self, _format, *_args):
        # Native request logs are configured separately; no headers/body/errors.
        pass

    def answer(self, code, value):
        body = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_POST(self):
        lengths = self.headers.get_all('Content-Length', [])
        if self.path == '/events':
            # Body parsing shares the absolute header deadline. Pub/Sub sends
            # a body even when it is merely a hint; discard all payload fields.
            valid = (not self.headers.get_all('Transfer-Encoding') and len(lengths) == 1
                     and re.fullmatch('[1-9][0-9]{0,5}', lengths[0])
                     and int(lengths[0]) <= MAX_HINT_BYTES
                     and self.headers.get('Content-Encoding', 'identity') == 'identity')
            if not valid:
                self.answer(200, {'status': 'STOP_INVALID_EVENT_HINT', 'build_success_claimed': False})
                return
            if len(self.rfile.read(int(lengths[0]))) != int(lengths[0]):
                self.answer(200, {'status': 'STOP_INCOMPLETE_EVENT_HINT', 'build_success_claimed': False})
                return
        elif self.path != '/tick' or self.headers.get_all('Transfer-Encoding') or lengths not in ([], ['0']):
            self.answer(400, {'status': 'INVALID_TICK_HINT'})
            return
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, self.parser_previous_handler)
        # Fixed code import, not an environment-selected or request-provided path.
        def installed_factory():
            from cloudbuild_runtime import RuntimeFactory
            return RuntimeFactory.from_installed_config()
        self.answer(200, tick(installed_factory, started=self.request_started))

    def do_GET(self):
        self.answer(405, {'status': 'POST_EMPTY_TICK_REQUIRED'})


if __name__ == '__main__':
    port = os.environ.get('PORT', '8080')
    if port != '8080':
        raise SystemExit('CONTROLLER_PORT_REJECTED')
    HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
