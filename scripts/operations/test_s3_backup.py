import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import s3_backup as s3


class Client:
    def __init__(self):self.objects={};self.corrupt=False;self.fail_key=None
    def put_object(self,**kw):
        if kw['Key']==self.fail_key:raise ValueError('synthetic_upload_failure')
        if kw['Key'] in self.objects:raise ValueError('overwrite_refused')
        self.objects[kw['Key']]={'body':kw['Body'].read(),'metadata':kw['Metadata'],'retain':kw['ObjectLockRetainUntilDate']}
        return {'VersionId':'synthetic-version'}
    def get_object(self,**kw):
        x=self.objects[kw['Key']]
        return {'Body':io.BytesIO(b'corrupt' if self.corrupt else x['body']), 'Metadata':x['metadata'],
            'ServerSideEncryption':'AES256','ObjectLockMode':'GOVERNANCE','ObjectLockRetainUntilDate':x['retain']}
    def get_paginator(self,_):return self
    def paginate(self,**kw):return [{'Contents':[{'Key':key} for key in self.objects if key.startswith(kw['Prefix'])]}]
    def head_object(self,**kw):return {'Metadata':self.objects[kw['Key']]['metadata']}


class S3Tests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.file=self.root/'test.dump.age';self.file.write_bytes(b'age-encryption.org/v1\nsynthetic ciphertext')
        self.client=Client();self.now=dt.datetime(2026,10,6,0,17,tzinfo=s3.UTC)
    def tearDown(self):self.tmp.cleanup()
    def test_all_classes_on_first_success(self):
        self.assertEqual(s3.classes(self.client,'bucket','database',self.now),['hourly','daily','weekly','monthly'])
        self.assertEqual(s3.period(self.now,'weekly'),'2026-10-05')
        self.assertEqual(s3.period(self.now,'monthly'),'2026-10')
    def test_periods_promote_first_success_not_specific_hour(self):
        self.client.objects['daily/database/2026-10-06/run/receipt.json.age']={'metadata':{'state':'verified'}}
        self.assertNotIn('daily',s3.classes(self.client,'bucket','database',self.now))
        self.assertIn('daily',s3.classes(self.client,'bucket','database',self.now+dt.timedelta(days=1)))
    def test_incomplete_period_is_not_success(self):
        self.client.objects['daily/database/2026-10-06/run/test.dump.age']={}
        self.assertIn('daily',s3.classes(self.client,'bucket','database',self.now))
    def test_streamed_readback_hash_version_lock(self):
        result=s3.put_verified(self.client,'bucket','hourly/database/run/test.dump.age',self.file,2)
        self.assertEqual(result['sha256'],hashlib.sha256(self.file.read_bytes()).hexdigest())
        self.assertEqual(result['version_id'],'synthetic-version')
    def test_plaintext_rejected(self):
        self.file.write_bytes(b'COPY patient private values')
        with self.assertRaises(ValueError):s3.put_verified(self.client,'bucket','hourly/test.dump.age',self.file,2)
        self.assertFalse(self.client.objects)
    def test_remote_corruption_rejected(self):
        self.client.corrupt=True
        with self.assertRaises(ValueError):s3.put_verified(self.client,'bucket','hourly/test.dump.age',self.file,2)
    def test_upload_failure_produces_no_completion_marker(self):
        self.client.fail_key='hourly/database/2026-10-06/run/test.dump.age'
        with self.assertRaises(ValueError):s3.upload_set(self.client,'bucket','database',[self.file],self.root/'recipients',self.root,self.now,'run',self.now.isoformat())
        self.assertFalse(any(key.endswith('receipt.json.age') for key in self.client.objects))
    def test_late_promotion_failure_never_marks_hourly_complete(self):
        self.client.fail_key='monthly/database/2026-10/run/test.dump.age'
        with self.assertRaises(ValueError):s3.upload_set(self.client,'bucket','database',[self.file],self.root/'recipients',self.root,self.now,'run',self.now.isoformat())
        self.assertFalse(any(key.endswith('receipt.json.age') for key in self.client.objects))
    def test_missing_freshness_is_failure(self):
        with self.assertRaises(ValueError):s3.freshness(self.client,'bucket')
    def test_old_snapshot_even_recent_completion_is_stale(self):
        now=dt.datetime.now(s3.UTC);key=f'hourly/database/{now:%Y-%m-%d}/run/receipt.json.age'
        self.client.objects[key]={'metadata':{'state':'verified','source-time':(now-dt.timedelta(minutes=76)).isoformat(),'completed-at':now.isoformat()}}
        with self.assertRaises(ValueError):s3.freshness(self.client,'bucket')
    def test_no_overwrite(self):
        s3.put_verified(self.client,'bucket','hourly/test.dump.age',self.file,2)
        with self.assertRaises(ValueError):s3.put_verified(self.client,'bucket','hourly/test.dump.age',self.file,2)
    def test_monthly_never_shorter_than_twelve_calendar_months(self):
        self.assertEqual(s3.RETENTION['monthly'],366)
        self.assertEqual(s3.RETENTION['weekly'],84)


if __name__=='__main__':unittest.main()
