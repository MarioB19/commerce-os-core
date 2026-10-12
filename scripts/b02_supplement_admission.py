"""Closed November B02 supplement validator; no I/O or execution authority.

Only the canonical Root adapter may supply authenticated originals/context.
Eligibility must be checked in BOTH authorize and execute while all four B02
locks are held. The existing global slot claim and permits remain authoritative.
This module never resets MAX37, edits historical journals, or retries a slot.
"""
import datetime as dt
import hashlib
import json
import re
from b02_quota_coverage import BASE_LIMIT, FINANCIAL_END, NOVEMBER_SLOTS, WINDOW, ledger, money, need, timestamp


def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def pin(value):
    need(type(value)is str and re.fullmatch('[a-f0-9]{64}',value),'SUPPLEMENT_PIN_REQUIRED')
    return value


def evaluate(admission, *, expected, records, context, claims, now):
    """Pure validation of a Root-owned admission and authentic Google context.

    `expected` is read from the installed canonical source, plan, binding and
    economic originals, never supplied by the invoking backup client. `claims`
    includes all original schedule claims, even abandoned/failed authorizations.
    A successful result cannot be used alone to dispatch: the native adapter
    still verifies current runtime, paused barriers, slot uniqueness and creates
    its O_EXCL permit/claim before returning anything to the worker.
    """
    moment=timestamp(now)
    fields={'schema_version','kind','issued_at','expires_at','financial_valid_until','source_sha','plan_sha256','binding_sha256','economic_sha256','cost_proposal_sha256','billing_timezone','baseline','slots','monthly'}
    need(type(admission)is dict and set(admission)==fields,'SUPPLEMENT_FIELDS')
    need(type(expected)is dict and set(expected)=={'source_sha','plan_sha256','binding_sha256','economic_sha256','cost_proposal_sha256'},'SUPPLEMENT_NATIVE_EXPECTATIONS_REQUIRED')
    need(admission['schema_version']==3 and type(admission['schema_version'])is int and admission['kind']=='B02_NOVEMBER_SCHEDULED_SUPPLEMENT','SUPPLEMENT_KIND')
    need(re.fullmatch('[a-f0-9]{40}',expected['source_sha']) and all(pin(expected[k]) for k in expected if k!='source_sha'),'SUPPLEMENT_EXPECTED_IDENTITY')
    need(all(admission[k]==v for k,v in expected.items()),'SUPPLEMENT_CURRENT_IDENTITY_CHANGED')
    issued=timestamp(admission['issued_at']);expiry=timestamp(admission['expires_at'])
    need(issued<=moment<expiry<=FINANCIAL_END and timestamp(admission['financial_valid_until'])==FINANCIAL_END,'SUPPLEMENT_FINANCIAL_WINDOW')
    need(moment.strftime('%Y-%m')=='2026-11','SUPPLEMENT_MONTH')
    need(type(admission['slots'])is list and tuple(timestamp(s)for s in admission['slots'])==NOVEMBER_SLOTS,'SUPPLEMENT_EXACT_SLOTS')
    need(admission['billing_timezone']=='America/Los_Angeles','SUPPLEMENT_BILLING_TIMEZONE')
    need(type(admission['monthly'])is dict and set(admission['monthly'])=={'2026-10','2026-11','2026-12'},'SUPPLEMENT_MONTHLY_ENVELOPES_REQUIRED')
    for row in admission['monthly'].values():
        need(type(row)is dict and set(row)=={'previous_gross_usd','marginal_gross_usd','total_gross_usd'},'SUPPLEMENT_MONTHLY_FIELDS')
        previous=money(row['previous_gross_usd']);extra=money(row['marginal_gross_usd']);total=money(row['total_gross_usd'])
        need(extra>0 and total>=previous+extra and total<=100,'SUPPLEMENT_GROSS_BUDGET')
    old=ledger(admission['baseline'],admission['issued_at']);current=ledger(records,now)
    original={row[1]:row[2] for row in old};live={row[1]:row[2] for row in current}
    need(original and all(live.get(run)==row for run,row in original.items()),'SUPPLEMENT_HISTORY_CHANGED_OR_REMOVED')
    need(type(context)is dict and set(context)=={'run_id','mode','slot','source_sha','execution_uid'},'SUPPLEMENT_GOOGLE_CONTEXT_REQUIRED')
    run=context['run_id'];uid=context['execution_uid']
    need(type(uid)is str and re.fullmatch('[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}',uid) and run=='gcp-'+uid.replace('-',''),'SUPPLEMENT_EXECUTION_IDENTITY')
    need(context['mode']=='SCHEDULED' and context['source_sha']==expected['source_sha'],'SUPPLEMENT_SCHEDULED_ONLY')
    slot=timestamp(context['slot']);need(slot in NOVEMBER_SLOTS and dt.timedelta(0)<=moment-slot<dt.timedelta(minutes=30),'SUPPLEMENT_SLOT_WINDOW')
    need(type(claims)is list,'SUPPLEMENT_CLAIMS_REQUIRED')
    seen_slots=set();seen_runs=set()
    for item in claims:
        need(type(item)is dict and set(item)=={'slot','run_id','sha256'} and type(item['run_id'])is str and re.fullmatch('gcp-[a-f0-9]{32}',item['run_id']),'SUPPLEMENT_CLAIM_FIELDS')
        claimed=timestamp(item['slot']);pin(item['sha256'])
        need(claimed not in seen_slots and item['run_id']not in seen_runs,'SUPPLEMENT_CLAIMS_DUPLICATE');seen_slots.add(claimed);seen_runs.add(item['run_id'])
        # A claim for this run may already exist at execute; it must remain bound
        # to this exact scheduled slot. All other claims permanently consume it.
        need((claimed!=slot and item['run_id']!=run) or (claimed==slot and item['run_id']==run),'SUPPLEMENT_SLOT_ALREADY_CONSUMED')
    need(run not in live,'SUPPLEMENT_EXISTING_JOURNAL_REQUIRES_CANONICAL_READBACK')
    active=sum(at>=moment-WINDOW for at,_,_ in current)
    need(BASE_LIMIT<=active<BASE_LIMIT+3,'SUPPLEMENT_ROLLING_SCOPE')
    extra_claims=sum(s in NOVEMBER_SLOTS for s in seen_slots)
    need(extra_claims<3 or (slot in seen_slots and run in seen_runs),'SUPPLEMENT_THREE_CLAIMS_MAX')
    return {'state':'B02_SUPPLEMENT_ELIGIBILITY_ONLY','slot':slot.isoformat(),'run_id':run,'rolling_starts_before':active,'admission_sha256':digest(admission),'base_limit_unchanged':BASE_LIMIT,'history_preserved':True,'execution_authorized':False,'automatic_retry':False}
