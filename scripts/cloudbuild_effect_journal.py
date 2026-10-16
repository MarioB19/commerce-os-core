"""Durable callbacks for publication and source effects under a CI reservation.

The journal object is separately initialized once by the trusted controller and
bound into protected attempt custody before a publisher starts. Runtime methods
never create an absent journal: deletion is an incident, not a fresh attempt.
The parent ledger remains authoritative for exclusion, approval and spending.
"""
from copy import deepcopy
import re
import cloudbuild_admission as ledger

MAX_ACTIONS = 8
MAX_RESULT_BYTES = 16384


def fresh_binding(parent_store, attempt_id, moment):
    generation, document=parent_store.load()
    ledger.need(document is not None,'LEDGER_MISSING_NO_RESET');ledger.validate_ledger(document)
    attempt=document['attempts'].get(attempt_id,{})
    ledger.need(document['blocked'] is None and document['active_attempt']==attempt_id
        and attempt.get('state') in {'RESERVED','SUBMIT_INTENT','UUID_BOUND','RUNNING','UNKNOWN'}
        and attempt['plan']['stage'] in {'full','package','publisher'},'EFFECT_ACTIVE_RESERVATION_REQUIRED')
    ledger.validate_approval(attempt['approval'],attempt['plan'],moment)
    ledger.validate_admission(attempt['admission'],moment,attempt['approval'])
    binding={'attempt_id':attempt_id,'plan_sha256':ledger.canonical_hash(attempt['plan']),
             'source_sha':attempt['plan']['identity']['source_sha']}
    return generation,binding


def initial_journal(binding):
    ledger.exact(binding,'attempt_id plan_sha256 source_sha','EFFECT_BINDING_FIELDS_INVALID')
    ledger.native_uuid(binding['attempt_id']);ledger.digest(binding['plan_sha256']);ledger.digest(binding['source_sha'],size=40)
    return {'schema_version':1,'binding':deepcopy(binding),'revision':0,'actions':{}}


def validate_journal(document,binding):
    ledger.exact(document,'schema_version binding revision actions','EFFECT_JOURNAL_FIELDS_INVALID')
    ledger.need(type(document['schema_version']) is int and document['schema_version']==1
        and document['binding']==binding and type(document['revision']) is int and document['revision']>=0
        and type(document['actions']) is dict and len(document['actions'])<=MAX_ACTIONS,'EFFECT_JOURNAL_BINDING_CHANGED')
    for action,value in document['actions'].items():
        action_name(action)
        ledger.exact(value,'intent_sha256 created_at result history','EFFECT_ACTION_FIELDS_INVALID')
        ledger.digest(value['intent_sha256']);ledger.timestamp(value['created_at'])
        if value['result'] is not None:validate_result(value['result'],value['intent_sha256'])
        ledger.need(type(value['history']) is list and len(value['history'])<=8,'EFFECT_HISTORY_INVALID')
        for previous in value['history']:validate_result(previous,value['intent_sha256'])


def action_name(action):
    ledger.need(type(action) is str and re.fullmatch(r'[a-z][a-z0-9:_-]{0,159}',action),'EFFECT_ACTION_INVALID')


def validate_result(result,intent_sha256):
    ledger.need(type(result) is dict and result.get('status') in {'UNKNOWN','RESPONSE_RECEIVED','RECONCILED'}
        and result.get('intent_sha256')==intent_sha256,'EFFECT_RESULT_BINDING_CHANGED')
    import json
    try:raw=json.dumps(result,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    except (ValueError,TypeError):raise ledger.AdmissionError('EFFECT_RESULT_JSON_INVALID') from None
    ledger.need(len(raw)<=MAX_RESULT_BYTES,'EFFECT_RESULT_TOO_LARGE')
    def inspect(value):
        if type(value) is dict:
            ledger.need(all(type(k) is str and not re.search(r'token|secret|password|authorization|credential|environment',k,re.I)
                            for k in value),'EFFECT_RESULT_CREDENTIAL_FIELD_FORBIDDEN')
            for child in value.values():inspect(child)
        elif type(value) is list:
            for child in value:inspect(child)
    inspect(result)


def initialize_journal(store,parent_store,attempt_id,*,now):
    """Explicit once-only setup; never call automatically after a missing read.

    The controller binds the resulting object generation into immutable attempt
    custody before launching any effect-capable process. This is not a recovery
    function and cannot authorize recreation after a previously initialized
    journal is deleted.
    """
    _parent_generation,binding=fresh_binding(parent_store,attempt_id,now)
    generation,document=store.load()
    ledger.need(generation=='0' and document is None,'EFFECT_INITIALIZATION_REQUIRES_ABSENT_OBJECT')
    result=store.compare_and_swap('0',initial_journal(binding))
    ledger.need(type(result) is str and re.fullmatch('[1-9][0-9]*',result),'EFFECT_INITIALIZATION_UNCONFIRMED')
    return {'generation':result,'binding':binding}


class DurableEffectJournal:
    def __init__(self,store,parent_store,binding,*,clock):
        initial_journal(binding)
        self.store=store;self.parent_store=parent_store;self.binding=deepcopy(binding);self.clock=clock

    def _load(self):
        generation,document=self.store.load()
        ledger.need(document is not None and generation!='0','EFFECT_JOURNAL_MISSING_NO_RESET')
        validate_journal(document,self.binding)
        return generation,document

    def commit_intent(self,action,payload):
        action_name(action);ledger.need(type(payload) is dict,'EFFECT_PAYLOAD_REQUIRED')
        intent=ledger.canonical_hash(payload)
        parent_generation,binding=fresh_binding(self.parent_store,self.binding['attempt_id'],self.clock())
        ledger.need(binding==self.binding,'EFFECT_PARENT_BINDING_CHANGED')
        generation,document=self._load()
        if action in document['actions']:
            ledger.need(document['actions'][action]['intent_sha256']==intent,'EFFECT_REPLAY_PAYLOAD_CHANGED')
            return {'effect':None,'intent_sha256':intent,'fencing_generation':generation,'attempt_id':binding['attempt_id']}
        ledger.need(len(document['actions'])<MAX_ACTIONS,'EFFECT_ACTION_LIMIT')
        document['actions'][action]={'intent_sha256':intent,'created_at':ledger.stamp(self.clock()),'result':None,'history':[]}
        document['revision']+=1;validate_journal(document,binding)
        committed=self.store.compare_and_swap(generation,document)
        if not (type(committed) is str and re.fullmatch('[1-9][0-9]*',committed) and committed!=generation):
            raise ledger.CommitOutcomeUnknown('EFFECT_CAS_UNCONFIRMED_NO_EFFECT')
        # Parent advancement during this CAS closes the operation. No effect is
        # returned; the committed intent stays consumed for reconciliation.
        observed,again=fresh_binding(self.parent_store,binding['attempt_id'],self.clock())
        ledger.need(observed==parent_generation and again==binding,'EFFECT_PARENT_ADVANCED_NO_DISPATCH')
        return {'effect':'CREATE_ONCE','intent_sha256':intent,'fencing_generation':committed,'attempt_id':binding['attempt_id']}

    def record_result(self,action,result):
        action_name(action);generation,document=self._load()
        ledger.need(action in document['actions'],'EFFECT_INTENT_REQUIRED')
        value=document['actions'][action];validate_result(result,value['intent_sha256'])
        previous=value['result']
        if previous==result:return {'generation':generation,'result':deepcopy(previous)}
        if previous is not None:
            # An uncertain fallback after a successful but unacknowledged CAS
            # must never erase the native ID/digest that actually committed.
            if previous['status']!='UNKNOWN' and result['status']=='UNKNOWN':
                return {'generation':generation,'result':deepcopy(previous)}
            ledger.need(previous['status']=='UNKNOWN' or result['status']=='RECONCILED','EFFECT_RESULT_CONFLICT')
            if 'native_id' in previous:
                ledger.need(result.get('native_id')==previous['native_id'],'EFFECT_NATIVE_ID_CHANGED')
            ledger.need(len(value['history'])<8,'EFFECT_HISTORY_LIMIT')
            value['history'].append(deepcopy(previous))
        value['result']=deepcopy(result);document['revision']+=1;validate_journal(document,self.binding)
        committed=self.store.compare_and_swap(generation,document)
        if not (type(committed) is str and re.fullmatch('[1-9][0-9]*',committed) and committed!=generation):
            raise ledger.CommitOutcomeUnknown('EFFECT_RESULT_CAS_UNCONFIRMED')
        return {'generation':committed,'result':deepcopy(result)}
