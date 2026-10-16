"""Synthetic native-original fixtures only. No claimed backup/restore."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'scripts'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
import privacy_backup_rows as p
from test_privacy_backup_attestation import Fixture as BaseFixture,SOURCE,NOW,DEPLOYED

class Fixture:
 def __init__(self):
  self.base=BaseFixture();self.native=self.base.native;self.backup=str(uuid.uuid4());self.pages={}
  entries=[{'relation':'public.records','key_sha256':'a'*64,'source_sha256':'b'*64}]
  for name,phase,target,start,end in [('source_rows_before','SOURCE_BEFORE_BACKUP','source-cluster/database','2026-10-11T12:58:00Z','2026-10-11T12:59:00Z'),('source_rows_after','SOURCE_AFTER_BACKUP','source-cluster/database','2026-10-11T13:10:30Z','2026-10-11T13:11:00Z'),('restored_rows','RESTORED_DATABASE','isolated-cluster/database','2026-10-11T13:18:00Z','2026-10-11T13:19:00Z')]:
   token=str(uuid.uuid4());page={'schema_version':1,'kind':'PRIVATE_ROW_PAGE','capture_id':token,'workspace_id':'profile','environment':'REAL','catalog_sha256':'e'*64,'page_index':0,'entries':copy.deepcopy(entries),'page_sha256':p.page_hash(entries),'root_sha256':p.chain(p.ROOT,p.page_hash(entries)),'row_count':'1','complete':True,'started_at':start,'observed_at':end}
   self.pages[name]=page
   self.base.put(name,{'schema_version':1,'kind':'D18_NATIVE_ROW_READBACK','phase':phase,'run_id':self.native.docs['root_report']['run_id'],'target':target,'capture_sha256':'f'*64,'source_manifest_ref':self.native.refs['deployed_sources'],'ciphertext_sha256':self.native.docs['staging_plan']['files']['ciphertext.backup.aes']['sha256'],'restore_receipt_ref':self.native.refs['restore_receipt'] if name=='restored_rows' else None,'capture':{'schema_version':1,'kind':'PRIVATE_ROW_CAPTURE','token':token,'workspace_id':'profile','environment':'REAL','catalog_sha256':'e'*64,'relations':['public.records','public.record_versions']},'pages':[]})
  self.refresh()
 def refresh(self):
  self.raws={}
  for name,page in self.pages.items():
   raw=p.base.canonical(page);ref={'path':'/private/synthetic/'+name+'-page.json','bytes':len(raw),'sha256':p.base.sha(raw)};self.raws[ref['path']]=raw
   self.base.change(name,lambda d,ref=ref:d.update(pages=[ref]))
 def reader(self,ref):return self.raws[ref['path']] if ref['path'] in self.raws else self.native.read(ref)
 def validate(self,path):
  return p.prepare_privacy_backup_rows(self.native.refs,self.reader,backup_id=self.backup,workspace_id='profile',expected_capture_sha256='f'*64,expected_catalog_sha256='e'*64,spool_directory=path,expected_backup_source_sha='b'*40,expected_restore_source_sha=SOURCE,expected_deployed_source_sha=DEPLOYED,expected_readback_queries_sha256=self.native.refs['readback_queries']['sha256'],expected_files=self.base.files,source_target='source-cluster/database',restored_target='isolated-cluster/database',now=NOW)
 def change_entries(self,name,entries):
  self.pages[name].update(entries=entries,page_sha256=p.page_hash(entries),root_sha256=p.chain(p.ROOT,p.page_hash(entries)),row_count=str(len(entries)));self.refresh()

class RowsTests(unittest.TestCase):
 def run_fixture(self,f):
  with tempfile.TemporaryDirectory() as d:return f.validate(Path(d)/'new')
 def test_exact_complete_triple_produces_only_private_inert_import(self):
  out=self.run_fixture(Fixture());self.assertEqual(out['row_arguments']['row_count'],'1');self.assertFalse(out['erasure_authorized']);self.assertFalse(out['import_authorized'])
 def test_changed_row_with_same_timestamp_is_not_covered(self):
  f=Fixture();e=copy.deepcopy(f.pages['source_rows_after']['entries']);e[0]['source_sha256']='d'*64;f.change_entries('source_rows_after',e);self.assertEqual(self.run_fixture(f)['row_arguments']['row_count'],'0')
 def test_unrelated_new_row_does_not_block_exact_covered_rows(self):
  f=Fixture();e=copy.deepcopy(f.pages['source_rows_after']['entries']);e.append({'relation':'public.records','key_sha256':'c'*64,'source_sha256':'d'*64});f.change_entries('source_rows_after',e);self.assertEqual(self.run_fixture(f)['row_arguments']['row_count'],'1')
 def test_missing_restored_row_cannot_be_covered(self):
  f=Fixture();f.change_entries('restored_rows',[]);self.assertEqual(self.run_fixture(f)['row_arguments']['row_count'],'0')
 def test_incomplete_capture_rejected_not_treated_as_missing_rows(self):
  f=Fixture();f.pages['restored_rows']['complete']=False;f.refresh()
  with self.assertRaisesRegex(Exception,'PAGE_BINDING'):self.run_fixture(f)
 def test_wrong_count_root_or_page_hash_rejected(self):
  for field,value in [('row_count','2'),('root_sha256','0'*64),('page_sha256','0'*64)]:
   f=Fixture();f.pages['restored_rows'][field]=value;f.refresh()
   with self.subTest(field=field),self.assertRaisesRegex(Exception,'COUNT_OR_ROOT'):self.run_fixture(f)
 def test_scope_capture_or_catalog_mismatch_rejected(self):
  for field,value in [('workspace_id','other'),('environment','SIMULATION'),('capture_id',str(uuid.uuid4())),('catalog_sha256','0'*64)]:
   f=Fixture();f.pages['restored_rows'][field]=value;f.refresh()
   with self.subTest(field=field),self.assertRaisesRegex(Exception,'PAGE_BINDING'):self.run_fixture(f)
 def test_borrowing_restore_receipt_or_target_rejected(self):
  for field,value in [('target','source-cluster/database'),('restore_receipt_ref',None),('capture_sha256','a'*64)]:
   f=Fixture();f.base.change('restored_rows',lambda d:d.update({field:value}))
   with self.subTest(field=field),self.assertRaisesRegex(Exception,'BINDING'):self.run_fixture(f)
 def test_duplicate_key_rejected_even_when_hash_and_count_match(self):
  f=Fixture();e=f.pages['restored_rows']['entries'];f.change_entries('restored_rows',e+e)
  with self.assertRaisesRegex(Exception,'ORDER'):self.run_fixture(f)
 def test_changed_original_bytes_rejected(self):
  f=Fixture();ref=f.native.docs['restored_rows']['pages'][0];f.raws[ref['path']]+=b' '
  with self.assertRaisesRegex(Exception,'ORIGINAL_CHANGED'):self.run_fixture(f)
 def test_private_spool_must_be_new_and_failure_does_not_erase_prior_files(self):
  f=Fixture()
  with tempfile.TemporaryDirectory() as d:
   path=Path(d)/'existing';path.mkdir();(path/'sentinel').write_text('keep')
   with self.assertRaisesRegex(Exception,'NEW_SPOOL'):f.validate(path)
   self.assertEqual((path/'sentinel').read_text(),'keep')
 def test_page_bound_and_unknown_relation_rejected(self):
  f=Fixture();e=[{'relation':'unknown','key_sha256':'a'*64,'source_sha256':'b'*64}];f.change_entries('restored_rows',e)
  with self.assertRaisesRegex(Exception,'RELATION'):self.run_fixture(f)

class PageScaleTests(unittest.TestCase):
 def test_exact_multiple_empty_terminal_is_repaginated_without_empty_import_page(self):
  f=Fixture()
  for name,old in list(f.pages.items()):
   entries=[{'relation':'public.records','key_sha256':f'{i:064x}','source_sha256':'b'*64} for i in range(2000)]
   root=p.chain(p.ROOT,p.page_hash(entries));refs=[]
   for index,values in enumerate([entries,[]]):
    digest=p.page_hash(values)
    if index:root=p.chain(root,digest)
    page={**old,'entries':values,'page_index':index,'complete':index==1,'page_sha256':digest,'root_sha256':root,'row_count':'2000'}
    raw=p.base.canonical(page);ref={'path':f'/private/synthetic/{name}-{index}.json','bytes':len(raw),'sha256':p.base.sha(raw)}
    f.raws[ref['path']]=raw;refs.append(ref)
   f.base.change(name,lambda d,refs=refs:d.update(pages=refs))
  with tempfile.TemporaryDirectory() as d:
   result=f.validate(Path(d)/'new');self.assertEqual(result['row_arguments']['page_count'],1);self.assertEqual(result['row_arguments']['row_count'],'2000')
   self.assertEqual(len(p.json.loads(Path(result['row_arguments']['pages'][0]['path']).read_bytes())),2000)
 def test_streaming_capture_accepts_more_than_old_100k_bound_without_truncation(self):
  f=Fixture();name='restored_rows';old=f.pages[name];doc=copy.deepcopy(f.native.docs[name]);total=100001;refs=[];root=p.ROOT;raws={}
  for index,offset in enumerate(range(0,total,2000)):
   entries=[{'relation':'public.records','key_sha256':f'{i:064x}','source_sha256':'b'*64} for i in range(offset,min(offset+2000,total))]
   digest=p.page_hash(entries);root=p.chain(root,digest);page={**old,'page_index':index,'entries':entries,'complete':offset+len(entries)==total,'row_count':str(offset+len(entries)),'root_sha256':root,'page_sha256':digest}
   raw=p.base.canonical(page);ref={'path':f'/private/large/{index}.json','bytes':len(raw),'sha256':p.base.sha(raw)};refs.append(ref);raws[ref['path']]=raw
  doc['pages']=refs;counts=[];result=p.consume_capture(doc,lambda ref:raws[ref['path']],workspace='profile',catalog='e'*64,ingest=lambda rows:counts.append(len(rows)))
  self.assertEqual(result['count'],total);self.assertEqual(sum(counts),total);self.assertEqual(result['root_sha256'],root)

if __name__=='__main__':unittest.main()
