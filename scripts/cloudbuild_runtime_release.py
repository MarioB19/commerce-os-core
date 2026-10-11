"""Image-owned release composition, never an HTTP-provided factory or plan.

The installed runtime provides authenticated custody, the existing ledger and
ADC transports. All creations have durable intents; redelivery uses native GET
reconciliation. Controller and worker journals are disjoint objects.
"""
from copy import deepcopy

import cloudbuild_admission as ledger
import cloudbuild_publisher_contract as publisher
from cloudbuild_custody_writer import PublisherCustodyWriter
from cloudbuild_effect_journal import DurableEffectJournal, initial_journal
from cloudbuild_full_evidence import need
from cloudbuild_gcs_store import GCSAdmissionStore
from cloudbuild_native_package import GooglePackageReader
from cloudbuild_release_controller import ReleaseController, SHAPE_UUID
from cloudbuild_source_replica import SourceReplica
from cloudbuild_project_inventory import PacedCloudBuildReads


def binding(task):
    return {'attempt_id': task['attempt_id'], 'plan_sha256': ledger.canonical_hash(task['plan']),
            'source_sha': task['plan']['identity']['source_sha']}


class ReleaseRuntime:
    def __init__(self, factory, work):
        self.factory = factory; self.work = work
        self.task = factory._current(work); self.payload = self.task['payload']
        self.reader = GooglePackageReader(factory.identity, factory.full_reader)
        self.reader.opener = PacedCloudBuildReads(self.reader.opener, factory.inventory_pacer)
        self.controller = ReleaseController(factory.ledger_store, factory.api, self.reader, factory.github,
            lambda attempt, proposal: factory._eligibility(work, attempt, proposal), clock=factory.clock)

    def journal(self, target):
        from cloudbuild_runtime import location
        location(target); config = self.factory.config
        need(target['bucket'] == config['custody']['bucket'] and target['object'] ==
             config['custody']['prefix'].rstrip('/') + '/controller-journals/' + self.task['attempt_id'] + '.json',
             'RELEASE_CONTROLLER_JOURNAL_CHANGED')
        result = DurableEffectJournal(self.factory._store(target), self.factory.ledger_store,
                                      binding(self.task), clock=self.factory.clock)
        result._load()  # Never bootstrap after a missing journal.
        return result

    def replica(self):
        ledger.exact(self.payload, 'verification original journal', 'RUNTIME_REPLICA_PAYLOAD_INVALID')
        task = self.factory._current(self.work)
        need(all(self.payload['verification'][k] == task['plan']['identity'][k]
                 for k in ('source_sha', 'source_tree')), 'RUNTIME_REPLICA_PLAN_CHANGED')
        self.factory._fence(self.work)
        journal = self.journal(self.payload['journal'])
        copier = SourceReplica(self.factory.identity, self.factory.config['sources']['bucket'],
            task['plan']['stage'], fence=lambda: self.factory._fence(self.work))
        _, history = journal._load()
        method = copier.reconcile if 'source-replica:' + task['attempt_id'] in history['actions'] else copier.copy_once
        if task['phase'] == 'REPLICA_RECONCILE': method = copier.reconcile
        return method(self.payload['verification'], self.payload['original'], task['attempt_id'], journal)

    def writer(self, fence):
        config = self.factory.config
        return PublisherCustodyWriter(config['custody']['bucket'], config['custody']['prefix'],
            lambda bucket, name: GCSAdmissionStore(bucket, name, self.factory.transport), fence=fence)

    def publisher_inputs(self, bundle):
        ledger.exact(bundle, 'body contract journal phase initial_control', 'RUNTIME_PUBLISHER_CUSTODY_INVALID')
        need(bundle['phase'] in {'INSTALL', 'RECONCILE'}, 'RUNTIME_PUBLISHER_PHASE_INVALID')
        need(type(bundle['contract']) is dict and 'build_id' not in bundle['contract'],
             'RUNTIME_PUBLISHER_UUID_MUST_BE_NATIVE')
        contract = {**deepcopy(bundle['contract']), 'build_id': SHAPE_UUID}
        publisher.validate_contract(contract)
        need(contract['attempt_id'] == self.task['attempt_id'] and
             all(contract[k] == self.task['plan']['identity'][k] for k in ('source_sha', 'source_tree')) and
             ledger.canonical_hash(publisher.template(contract)) == self.task['plan']['config_sha256'],
             'RUNTIME_PUBLISHER_TEMPLATE_CHANGED')
        writer = self.writer(lambda: self.factory._fence(self.work))
        expected = writer.payload('body', self.task['attempt_id'], bundle['body'])
        need(expected['sha256'] == contract['task_sha256'], 'RUNTIME_PUBLISHER_BODY_CHANGED')
        # Import only from the trusted image; the worker's validators are shared
        # without constructing a worker, acquiring a credential or touching Root.
        from cloudbuild_publisher_worker import validate_task, validate_body
        placeholder = {**expected, 'generation': '1'}  # Validation floor, never an observed descriptor.
        prepared = {'schema_version': 1, 'operation': 'PUBLISH_PREPARED', 'phase': bundle['phase'],
                    'body_ref': placeholder, 'contract': contract,
                    **{k: deepcopy(self.task[k]) for k in ('plan', 'approval', 'admission', 'expires_at')}}
        validate_task(prepared, SHAPE_UUID, self.factory.clock(), preparing=True)
        validate_body(bundle['body'], prepared, self.factory.clock())
        where = bundle['body']['journal']; config = self.factory.config
        need(where == {'bucket': config['custody']['bucket'],
            'object': writer.target('worker-journal', self.task['attempt_id']), 'minimum_generation': '1'},
            'RUNTIME_WORKER_JOURNAL_CHANGED')
        need(bundle['body']['expires_at'] == self.task['expires_at'], 'RUNTIME_PUBLISHER_EXPIRY_CHANGED')
        initial = bundle['initial_control']
        ledger.exact(initial, 'generation document', 'RUNTIME_INITIAL_CONTROL_INVALID')
        from cloudbuild_gcs_store import generation
        generation(initial['generation'])
        ledger.exact(initial['document'], 'schema_version mode expires_at task', 'RUNTIME_INITIAL_CONTROL_INVALID')
        need(type(initial['document']['schema_version']) is int and initial['document']['schema_version'] == 1 and
             initial['document']['mode'] == 'paused' and initial['document']['task'] is None, 'RUNTIME_INITIAL_CONTROL_INVALID')
        ledger.timestamp(initial['document']['expires_at'])
        return writer, self.journal(bundle['journal']), prepared

    def write_document(self, writer, journal, kind, document):
        action = 'custody-' + kind + ':' + self.task['attempt_id']
        _, history = journal._load()
        if action in history['actions']:
            return writer.reconcile(action, writer.payload(kind, self.task['attempt_id'], document), journal)
        return writer.create_once(kind, self.task['attempt_id'], document, journal)

    def control(self, writer, journal, phase, descriptor, bundle):
        action = 'custody-control-' + phase + ':' + self.task['attempt_id']
        _, history = journal._load()
        if phase == 'prepared':
            initial = bundle['initial_control']; observed = initial['generation']; before = initial['document']
        else:
            result = history['actions'].get('custody-control-prepared:' + self.task['attempt_id'], {}).get('result')
            task_result = history['actions'].get('custody-prepared:' + self.task['attempt_id'], {}).get('result')
            need(type(result) is dict and result.get('status') == 'RECONCILED' and
                 type(task_result) is dict and task_result.get('status') == 'RECONCILED',
                 'RUNTIME_PREPARED_CONTROL_REQUIRED')
            observed = result['descriptor']['generation']
            before = {'schema_version': 1, 'mode': 'active', 'expires_at': self.task['expires_at'],
                      'task': task_result['descriptor']}
        if action in history['actions']:
            # Reconstruct the exact committed payload from immutable custody or
            # a prior native receipt, including the old CAS generation. A lost
            # response only admits generation-bound reads, never another PUT.
            _, payload = writer.control_payload(phase, self.task['attempt_id'], observed, before,
                                                descriptor, self.task['expires_at'])
            return writer.reconcile(action, payload, journal)
        return writer.control_once(phase, self.task['attempt_id'], observed, before, descriptor,
                                   self.task['expires_at'], journal)

    def prepare(self, bundle):
        writer, journal, prepared = self.publisher_inputs(bundle)
        self.factory._fence(self.work)
        for kind, document in (('worker-journal', initial_journal(binding(self.task))), ('body', bundle['body'])):
            result = self.write_document(writer, journal, kind, document)
            if result['state'] != 'CUSTODY_CONFIRMED': return result
            if kind == 'body': prepared['body_ref'] = result['descriptor']
        result = self.write_document(writer, journal, 'prepared', prepared)
        if result['state'] != 'CUSTODY_CONFIRMED': return result
        result = self.control(writer, journal, 'prepared', result['descriptor'], bundle)
        return {**result, 'state': 'PUBLISHER_PREPARED' if result['state'] == 'CUSTODY_CONFIRMED' else result['state']}

    def bound_fence(self, build_id, contract):
        # The admitted creation has intentionally changed inventory. Bind only
        # that exact observed UUID; no CreateBuild/approval is authorized here.
        task = self.factory._current(self.work); _, doc = self.factory._ledger()
        row = doc['attempts'].get(task['attempt_id'], {})
        need(doc['blocked'] is None and doc['active_attempt'] == task['attempt_id'] and
             row.get('state') in {'UUID_BOUND', 'RUNNING'} and row.get('build_id') == build_id and
             all(row.get(k) == task[k] for k in ('plan', 'approval', 'admission')), 'RUNTIME_PUBLISHER_BINDING_CHANGED')
        need(row.get('intent', {}).get('request_sha256') == ledger.canonical_hash(publisher.create_request(contract)) and
             row.get('intent', {}).get('source') == {**contract['storage_source'], 'archive_sha256': contract['archive_sha256']},
             'RUNTIME_PUBLISHER_INTENT_CHANGED')
        ledger.validate_approval(task['approval'], task['plan'], self.factory.clock())
        ledger.validate_admission(task['admission'], self.factory.clock(), task['approval'])
        self.factory.github.current_event(task['event'])
        status = publisher.validate_native(contract, self.factory.api.build(build_id), self.factory.config['project_number'])
        need(status in {'QUEUED', 'WORKING'}, 'RUNTIME_PUBLISHER_BINDING_TOO_LATE')
        self.factory._current(self.work); _, latest = self.factory._ledger()
        need(latest['blocked'] is None and latest['active_attempt'] == task['attempt_id'] and
             latest['attempts'].get(task['attempt_id']) == row, 'RUNTIME_PUBLISHER_BINDING_CHANGED')
        from cloudbuild_runtime import validate_work_window
        validate_work_window(self.work, self.factory.clock)
        ledger.validate_approval(task['approval'], task['plan'], self.factory.clock())
        ledger.validate_admission(task['admission'], self.factory.clock(), task['approval'])

    def bind(self, bundle, build_id):
        writer, journal, prepared = self.publisher_inputs(bundle)
        contract = {**prepared['contract'], 'build_id': ledger.native_uuid(build_id)}
        self.bound_fence(build_id, contract)
        writer.fence = lambda: self.bound_fence(build_id, contract)
        _, history = journal._load()
        result = history['actions'].get('custody-body:' + self.task['attempt_id'], {}).get('result')
        need(type(result) is dict and result.get('status') == 'RECONCILED', 'RUNTIME_PREPARED_BODY_REQUIRED')
        body_ref = result['descriptor']
        need(self.factory.custody.read_json(body_ref) == bundle['body'], 'RUNTIME_PREPARED_BODY_CHANGED')
        bound = {**prepared, 'operation': 'PUBLISH', 'contract': contract, 'body_ref': body_ref}
        result = self.write_document(writer, journal, 'bound', bound)
        if result['state'] != 'CUSTODY_CONFIRMED': return result
        result = self.control(writer, journal, 'bound', result['descriptor'], bundle)
        return {**result, 'state': 'PUBLISHER_BOUND' if result['state'] == 'CUSTODY_CONFIRMED' else result['state'],
                'build_id': build_id}

    def execute(self):
        task = self.task
        if task['phase'] in {'REPLICA', 'REPLICA_RECONCILE'}: return self.replica()
        if task['phase'] == 'PREPARE':
            need(task['operation'] == 'PUBLISH', 'RUNTIME_PUBLISHER_OPERATION_REQUIRED')
            return self.prepare(self.payload)
        fields = 'proposal custody' if task['operation'] == 'PUBLISH' else 'proposal'
        ledger.exact(self.payload, fields, 'RUNTIME_RELEASE_PAYLOAD_INVALID')
        proposal = self.payload['proposal']
        need(proposal.get('kind') == ('publisher' if task['operation'] == 'PUBLISH' else 'package'),
             'RUNTIME_RELEASE_KIND_CHANGED')
        _, document = self.factory._ledger(); attempt = document['attempts'].get(task['attempt_id'], {})
        if task['operation'] == 'PUBLISH':
            need(proposal['contract'] == self.payload['custody']['contract'] and
                 proposal['release_admission'] == self.payload['custody']['body']['release_admission'],
                 'RUNTIME_PUBLISHER_PROPOSAL_CHANGED')
            if task['phase'] == 'DISPATCH' and 'intent' not in attempt:
                # Idempotent reads of already prepared custody; never CreateBuild
                # until the native control references exactly those bytes.
                result = self.prepare(self.payload['custody'])
                if result['state'] != 'PUBLISHER_PREPARED': return result
        method = self.controller.reconcile if 'intent' in attempt or task['phase'] == 'RECONCILE' else self.controller.dispatch
        result = method(task['attempt_id'], proposal)
        if task['operation'] == 'PUBLISH' and result['state'] in {'UUID_BOUND', 'PENDING'}:
            return self.bind(self.payload['custody'], result['build_id'])
        return result
