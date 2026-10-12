"""Pure B02 rolling-window forecast. No I/O, quota reset or execution permission."""
import datetime as dt
from decimal import Decimal, InvalidOperation, ROUND_CEILING
import re

UTC=dt.timezone.utc
BASE_LIMIT=37
WINDOW=dt.timedelta(days=30)
FINANCIAL_END=dt.datetime(2026,11,4,tzinfo=UTC)
NOVEMBER_SLOTS=tuple(dt.datetime(2026,11,day,6,45,tzinfo=UTC)for day in (1,2,3))

def need(value, code):
    if not value: raise RuntimeError(code)

def timestamp(value):
    try: result=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
    except (ValueError,AttributeError,TypeError): raise RuntimeError('COVERAGE_TIME_INVALID') from None
    need(result.tzinfo is not None and result.utcoffset()==dt.timedelta(0),'COVERAGE_TIME_NOT_UTC')
    return result

def money(value):
    need(type(value)is str and re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?',value),'COVERAGE_AMOUNT_INVALID')
    try: result=Decimal(value)
    except InvalidOperation: raise RuntimeError('COVERAGE_AMOUNT_INVALID') from None
    need(result.is_finite() and result>=0,'COVERAGE_AMOUNT_INVALID')
    return result

def rounded(value):
    return format(value.quantize(Decimal('0.000000001'),rounding=ROUND_CEILING),'f')

def ledger(records, observed_at):
    """The adapter must authenticate every original and complete enumeration."""
    now=timestamp(observed_at)
    need(type(records)is list,'COVERAGE_LEDGER_INVALID')
    result=[];seen=set()
    for item in records:
        need(type(item)is dict and set(item)=={'run_id','started_at','status','sha256'},'COVERAGE_LEDGER_FIELDS')
        run=item['run_id'];need(type(run)is str and re.fullmatch(r'(?:gcp-[a-f0-9]{32}|[0-9]+-[0-9]+)',run) and run not in seen,'COVERAGE_RUN_DUPLICATE_OR_INVALID');seen.add(run)
        need(type(item['sha256'])is str and re.fullmatch('[a-f0-9]{64}',item['sha256']),'COVERAGE_ORIGINAL_HASH_INVALID')
        need(item['status'] in {'RUNNING','SUCCEEDED','FAILED','FAILED_RECONCILED'},'COVERAGE_STATUS_INVALID')
        at=timestamp(item['started_at']);need(at<=now,'COVERAGE_FUTURE_START')
        result.append((at,run,item))
    return sorted(result,key=lambda row:(row[0],row[1]))

def daily_slots(start, end, schedule_utc):
    start=timestamp(start);end=timestamp(end)
    need(start<end and (end-start).days<=366,'COVERAGE_INTERVAL_INVALID')
    need(type(schedule_utc)is str and re.fullmatch(r'(?:[01][0-9]|2[0-3]):[0-5][0-9]',schedule_utc),'COVERAGE_SCHEDULE_INVALID')
    hour,minute=map(int,schedule_utc.split(':'))
    current=start.replace(hour=hour,minute=minute,second=0,microsecond=0)
    if current<start:current+=dt.timedelta(days=1)
    result=[]
    while current<end:
        result.append(current);current+=dt.timedelta(days=1)
    return result

def forecast(records, *, observed_at, valid_from, valid_until, schedule_utc='06:45'):
    """Blocked slots remain explicit; no failed-slot catch-up is invented."""
    old=ledger(records,observed_at);observed=timestamp(observed_at)
    need(timestamp(valid_from)<=observed<timestamp(valid_until)<=FINANCIAL_END,'COVERAGE_BINDING_WINDOW_INVALID')
    slots=daily_slots(observed_at,valid_until,schedule_utc)
    need(not slots or slots[0]>observed,'COVERAGE_CURRENT_SLOT_ALREADY_DUE')
    history=[row[0] for row in old];rows=[]
    for slot in slots:
        active=sum(t>=slot-WINDOW for t in history)
        admitted=active<BASE_LIMIT
        rows.append({'slot':slot.isoformat(),'rolling_starts_before':active,'base_admitted':admitted,'month':slot.strftime('%Y-%m')})
        # Projection assumes each admitted slot starts once regardless of outcome.
        if admitted:history.append(slot)
    return {'schema_version':1,'state':'B02_COVERAGE_FORECAST_ONLY','observed_at':observed_at,
        'historical_starts':len(old),'base_limit':BASE_LIMIT,'window_days':30,
        'ledger_hashes':{row[1]:row[2]['sha256']for row in old},'slots':rows,
        'uncovered_slots':[r['slot']for r in rows if not r['base_admitted']],
        'production_authorized':False,'history_preserved':True}

def reserve_supplement(slots, *, monthly_totals, rates, maximum_export_bytes):
    """Legacy Nov/Dec component estimate; NOT a complete admission model.

    The first UTC slot belongs to October Pacific. This function is retained
    solely to reproduce the old Nov/Dec components; schema3 requires an October
    envelope and the full Pacific producer as well. Never infer October zero.

    Lifecycle30 + soft-delete7 crosses into December. Reserve all three maximum
    objects for BOTH whole calendar months, plus one recovery allowance in each.
    These are potential monthly costs, not permission to restore twice. Actual
    absence must be established before storage is released; lifecycle is async.
    """
    need(type(slots)is list and tuple(timestamp(x)for x in slots)==NOVEMBER_SLOTS,'COVERAGE_SUPPLEMENT_EXACT_SLOTS_REQUIRED')
    need(type(maximum_export_bytes)is int and maximum_export_bytes==1024**3+65536,'COVERAGE_EXPORT_BOUND_CHANGED')
    fields={'vcpu_second','gib_second','storage_gib_month','cross_region_gib','internet_gib','class_a_thousand','class_b_thousand','logs_gib','tax_multiplier'}
    need(type(rates)is dict and set(rates)==fields,'COVERAGE_RATES_REQUIRED');r={k:money(v)for k,v in rates.items()}
    need(r['tax_multiplier']>=1,'COVERAGE_TAX_INVALID')
    months=('2026-11','2026-12')
    need(type(monthly_totals)is dict and set(monthly_totals)==set(months),'COVERAGE_NOVEMBER_DECEMBER_ENVELOPES_REQUIRED')
    gib=Decimal(maximum_export_bytes)/Decimal(1024**3);monthly={}
    for month in months:
        previous=money(monthly_totals[month]);need(previous<=100,'COVERAGE_EXISTING_OVER_BUDGET')
        # Storage and recovery are reserved in each possible billing month.
        # The canonical adapter must enforce these API/log byte allowances.
        parts={'compute':Decimal(3*1920)*(2*r['vcpu_second']+8*r['gib_second'])if month=='2026-11'else Decimal(0),
            'storage':3*gib*r['storage_gib_month'],
            'cross_region':3*gib*r['cross_region_gib'],'recovery_download':3*gib*r['internet_gib'],
            'class_a':Decimal(3*25)/1000*r['class_a_thousand']if month=='2026-11'else Decimal(0),
            'class_b':Decimal(3*100)/1000*r['class_b_thousand'],
            'logs':Decimal(3*65536)/Decimal(1024**3)*r['logs_gib']}
        cost=Decimal(rounded(sum(parts.values())*r['tax_multiplier']))
        total=Decimal(rounded(previous+cost))
        need(total<=100,'COVERAGE_SUPPLEMENT_OVER_BUDGET')
        monthly[month]={'previous_gross_usd':str(previous),'marginal_gross_usd':rounded(cost),'total_gross_usd':rounded(total),
            'parts_pre_tax_usd':{k:rounded(v)for k,v in parts.items()}}
    return {'schema_version':2,'state':'LEGACY_NOVEMBER_DECEMBER_COMPONENT_ESTIMATE_ONLY',
        'slots':slots,'maximum_export_bytes':maximum_export_bytes,'seconds_per_attempt':1920,
        'monthly':monthly,'lifecycle_days':30,'soft_delete_days':7,
        'nominal_last_retention_until':(NOVEMBER_SLOTS[-1]+dt.timedelta(days=37)).isoformat(),
        'storage_reserved_until':'2027-01-01T00:00:00+00:00','native_absence_required_before_release':True,
        'provider_deletion_deadline_proven':False,'october_budget_not_modelled':True,
        'admission_compatible':False,
        'production_authorized':False,'base_quota_changed':False,'refund':False}
