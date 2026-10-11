#!/usr/bin/env python3
"""Apply only Commerce OS's approved A record; preserve every unrelated record."""
import argparse, json, os, urllib.request
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('credential_file',type=Path)
p.add_argument('private_evidence_dir',type=Path)
p.add_argument('--apply',action='store_true')
a=p.parse_args()
repo=Path(__file__).resolve().parents[1]
dest=a.private_evidence_dir.resolve()
if dest==repo or repo in dest.parents: raise SystemExit('Store DNS snapshots outside the repository')
dest.mkdir(parents=True,exist_ok=True,mode=0o700)
dest.chmod(0o700)
env=dict(l.split('=',1) for l in a.credential_file.read_text().splitlines() if '=' in l and not l.startswith('#'))
token=env['HOSTINGER_API_TOKEN'].strip().strip('"').strip("'")
url='https://developers.hostinger.com/api/dns/v1/zones/inovaris.online'
def request(method='GET',body=None):
 data=None if body is None else json.dumps(body).encode()
 req=urllib.request.Request(url,data=data,method=method,headers={'Authorization':'Bearer '+token,'Accept':'application/json','Content-Type':'application/json','User-Agent':'CommerceOS-Deployment/0.1'})
 with urllib.request.urlopen(req,timeout=30) as response: return json.load(response)
def save(name,data):
 path=dest/name
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f: json.dump(data,f,indent=2)
def relevant(records): return [r for r in records if r.get('name')=='commerce-os']
def unrelated(records):
 # DNS resource records are unordered sets; the API may reorder TXT values after an unrelated addition.
 normalized=[]
 for r in records:
  if r.get('name')=='commerce-os': continue
  copy=dict(r)
  copy['records']=sorted(copy.get('records',[]),key=lambda x:json.dumps(x,sort_keys=True))
  normalized.append(json.dumps(copy,sort_keys=True))
 return sorted(normalized)
before=request()
current=relevant(before)
expected={'name':'commerce-os','type':'A','ttl':300,'records':[{'content':'34.26.170.26'}]}
if current:
 if len(current)==1 and current[0]['type']=='A' and [r['content'] for r in current[0]['records']]==['34.26.170.26']:
  print(json.dumps({'already_configured':True,'domain':'commerce-os.inovaris.online'}));raise SystemExit(0)
 raise SystemExit('Existing Commerce records differ; refusing replacement')
print(json.dumps({'planned_record':expected,'unrelated_groups':len(before),'apply':a.apply}))
if a.apply:
 import datetime
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
 save('dns-before-'+stamp+'.json',before)
 result=request('PUT',{'overwrite':False,'zone':[expected]})
 after=request()
 save('dns-after-'+stamp+'.json',after)
 actual=relevant(after)
 if len(actual)!=1 or actual[0]['type']!='A' or [r['content'] for r in actual[0]['records']]!=['34.26.170.26']:
  raise SystemExit('Record response requires inspection; no blind retry')
 if unrelated(before)!=unrelated(after): raise SystemExit('Other DNS records changed during verification; inspect private snapshots')
 print(json.dumps({'applied':True,'domain':'commerce-os.inovaris.online','address':'34.26.170.26','unrelated_records_unchanged':True}))
