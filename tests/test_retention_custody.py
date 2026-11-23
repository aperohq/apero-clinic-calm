import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/operations'))
spec=importlib.util.spec_from_file_location('export_ledger',ROOT/'scripts/retention/export-ledger.py')
ledger=importlib.util.module_from_spec(spec);spec.loader.exec_module(ledger)

class CustodyTests(unittest.TestCase):
 def test_backup_scope_allows_only_fixed_retention_cron(self):
  import database_backup as backup
  expected=[{'name':'apero-retention-daily','schedule':'23 2 * * *','command':'select public.retention_daily()','active':True}]
  self.assertTrue(backup.retention_cron_is_safe(expected))
  self.assertFalse(backup.retention_cron_is_safe(expected+[{'command':'arbitrary secret HTTP request'}]))
  self.assertFalse(backup.retention_cron_is_safe([{**expected[0],'command':'select unsafe()'}]))
 def test_integration_cron_requires_exact_scoped_command_and_encrypted_recovery(self):
  import database_backup as backup
  retention={'name':'apero-retention-daily','schedule':'23 2 * * *','command':'select public.retention_daily()','active':True}
  worker={'name':'apero-integrations-worker','schedule':'* * * * *','command':"select public.integration_scheduled_sync('00000000-0000-4000-8000-000000000001','abc123@group.calendar.google.com')",'active':True}
  self.assertTrue(backup.integration_cron_is_safe([worker,retention]))
  for command in [worker['command']+";select unsafe()", "select net.http_post('secret')",worker['command'].replace('abc123@group.calendar.google.com','primary@gmail.com')]:
   self.assertFalse(backup.integration_cron_is_safe([retention,{**worker,'command':command}]))
  self.assertFalse(backup.integration_cron_is_safe([retention,worker,worker]))
  with tempfile.TemporaryDirectory() as folder:
   path=Path(folder)/'config.age';path.write_text('plaintext-secret');path.chmod(0o600)
   with self.assertRaises(ValueError):backup.integration_recovery_config(path)
   path.write_bytes(b'age-encryption.org/v1\nsynthetic-ciphertext');self.assertEqual(backup.integration_recovery_config(path),path)
   path.chmod(0o644)
   with self.assertRaises(ValueError):backup.integration_recovery_config(path)
 def test_failed_upload_does_not_acknowledge_intents(self):
  class Connection:
   def execute(self,_):return self
   def fetchall(self):return [('00000000-0000-4000-8000-000000000001','clinic-id','conversations','row-id','clear_content','time','later',None)]
  ack=[]
  with tempfile.TemporaryDirectory() as folder:
   with patch.object(ledger.subprocess,'run',return_value=type('R',(),{'returncode':0})()),patch.object(ledger.storage,'check_bucket'),patch.object(ledger.storage,'put_verified',side_effect=ValueError('SENSITIVE raw provider response')):
    with self.assertRaises(ValueError):ledger.export_and_ack(Connection(),object(),'bucket',['age1fixture'],Path(folder)/'ledger.age',lambda ids:ack.extend(ids))
  self.assertEqual(ack,[])
 def test_custody_precedes_ack_and_payload_contains_identifiers_only(self):
  class Connection:
   def execute(self,_):return self
   def fetchall(self):return [('00000000-0000-4000-8000-000000000001','clinic-id','conversations','row-id','clear_content','time','later',None)]
  sequence=[]
  def encrypt(*args,**kw):
   payload=json.loads(kw['input'])
   self.assertEqual(set(payload['ledger'][0]),{'id','clinic_id','resource_table','resource_key','action','occurred_at','replay_until','durable_at'})
   return type('R',(),{'returncode':0})()
  with tempfile.TemporaryDirectory() as folder:
   with patch.object(ledger.subprocess,'run',side_effect=encrypt),patch.object(ledger.storage,'check_bucket'),patch.object(ledger.storage,'put_verified',side_effect=lambda *args:sequence.append('verified_upload')):
    ledger.export_and_ack(Connection(),object(),'bucket',['age1fixture'],Path(folder)/'ledger.age',lambda ids:sequence.append('ack'))
  self.assertEqual(sequence,['verified_upload','ack'])
 def test_disabled_exporter_logs_no_sensitive_values(self):
  with patch.dict(ledger.os.environ,{},clear=True),patch('sys.stdout',new_callable=io.StringIO) as output:
   self.assertEqual(ledger.main(),1)
   self.assertEqual(json.loads(output.getvalue()),{'category':'retention_ledger_custody','state':'failure','failure_category':'configuration_error'})
if __name__=='__main__':unittest.main()
