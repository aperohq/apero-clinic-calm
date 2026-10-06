#!/usr/bin/env python3
"""Private S3 adapter: ciphertext only, locked immutable keys, streamed read-back.
No static AWS credentials; boto3's default chain receives short-lived OIDC STS.
"""
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from database_backup import digest

REGION = 'me-south-1'
RETENTION = {'hourly':2, 'daily':35, 'weekly':84, 'monthly':366}
UTC = dt.timezone.utc


def client():
    import boto3
    from botocore.config import Config
    return boto3.client('s3', region_name=REGION, config=Config(retries={'mode':'standard','max_attempts':4}))


def check_bucket(s3, bucket):
    location = s3.get_bucket_location(Bucket=bucket)['LocationConstraint']
    public = s3.get_public_access_block(Bucket=bucket)['PublicAccessBlockConfiguration']
    status = s3.get_bucket_policy_status(Bucket=bucket)['PolicyStatus']
    policy = json.loads(s3.get_bucket_policy(Bucket=bucket)['Policy'])
    versioning = s3.get_bucket_versioning(Bucket=bucket)
    encryption = s3.get_bucket_encryption(Bucket=bucket)['ServerSideEncryptionConfiguration']['Rules']
    lifecycle = s3.get_bucket_lifecycle_configuration(Bucket=bucket)['Rules']
    lock = s3.get_object_lock_configuration(Bucket=bucket)['ObjectLockConfiguration']
    if location != REGION or not all(public.get(x) for x in ('BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets')) or status['IsPublic']:
        raise ValueError('bucket_not_private_bahrain')
    if versioning.get('Status') != 'Enabled' or lock.get('ObjectLockEnabled') != 'Enabled':
        raise ValueError('versioning_or_lock_missing')
    if not any(x.get('ServerSideEncryptionByDefault',{}).get('SSEAlgorithm') == 'AES256' for x in encryption):
        raise ValueError('encryption_missing')
    for prefix, days in RETENTION.items():
        rules = [x for x in lifecycle if x.get('Status')=='Enabled' and
                 (x.get('Prefix') == prefix+'/' or x.get('Filter',{}).get('Prefix') == prefix+'/')]
        if len(rules)!=1 or rules[0].get('Expiration',{}).get('Days')!=days or rules[0].get('NoncurrentVersionExpiration',{}).get('NoncurrentDays')!=1:
            raise ValueError('retention_mismatch')
    # The reviewed template has no extra enabled expiration filters.
    other = [x for x in lifecycle if x.get('Status')=='Enabled' and x.get('Id') not in {c+'-retention' for c in RETENTION}]
    if any(x.get('Expiration',{}).get('Days') or x.get('NoncurrentVersionExpiration') for x in other):
        raise ValueError('unexpected_retention_rule')
    statements = policy.get('Statement',[])
    required = {'TLSOnly','OnlyWriterAndRecoveryCanAccessObjects','RequireSSES3','RequireGovernanceLock','DenyUnencryptedFileNames'}
    if not required.issubset({x.get('Sid') for x in statements if x.get('Effect')=='Deny'}):
        raise ValueError('bucket_policy_missing_controls')


def period(now, kind):
    if kind == 'hourly': return now.strftime('%Y-%m-%d')
    if kind == 'daily': return now.strftime('%Y-%m-%d')
    if kind == 'weekly': return (now-dt.timedelta(days=now.weekday())).strftime('%Y-%m-%d')
    if kind == 'monthly': return now.strftime('%Y-%m')
    raise ValueError('unknown_retention')


def completed(s3, bucket, prefix):
    # A marker exists only after all encrypted files were read back successfully.
    for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
        for item in page.get('Contents',[]):
            if item['Key'].endswith('/receipt.json.age'):
                head = s3.head_object(Bucket=bucket, Key=item['Key'])
                if head.get('Metadata',{}).get('state')=='verified': return True
    return False


def classes(s3, bucket, scope, now):
    result = ['hourly']
    for kind in ('daily','weekly','monthly'):
        if not completed(s3,bucket,f'{kind}/{scope}/{period(now,kind)}/'):
            result.append(kind)
    return result


def put_verified(s3, bucket, key, path, days, metadata=None):
    if not key.endswith('.age') or path.is_symlink() or path.stat().st_size==0:
        raise ValueError('ciphertext_required')
    with path.open('rb') as file:
        if file.read(len(b'age-encryption.org/v1\n')) != b'age-encryption.org/v1\n':
            raise ValueError('age_header_required')
    checksum = digest(path)
    if path.stat().st_size > 5*1024**3:
        raise ValueError('single_put_size_limit_review_required')
    retain = dt.datetime.now(UTC) + dt.timedelta(days=days)
    with path.open('rb') as file:
        uploaded = s3.put_object(Bucket=bucket,Key=key,Body=file,
            ContentLength=path.stat().st_size, ServerSideEncryption='AES256',
            ChecksumSHA256=base64.b64encode(bytes.fromhex(checksum)).decode(),
            Metadata={'sha256':checksum,**(metadata or {})},IfNoneMatch='*',
            ObjectLockMode='GOVERNANCE',ObjectLockRetainUntilDate=retain)
    version = uploaded.get('VersionId')
    if not version: raise ValueError('version_id_missing')
    fetched = s3.get_object(Bucket=bucket,Key=key,VersionId=version,ChecksumMode='ENABLED')
    try:
        if fetched.get('ServerSideEncryption')!='AES256' or fetched.get('ObjectLockMode')!='GOVERNANCE' or fetched.get('ObjectLockRetainUntilDate',dt.datetime.min.replace(tzinfo=UTC)) < retain-dt.timedelta(seconds=1):
            raise ValueError('remote_security_mismatch')
        hashed = hashlib.sha256(); size=0
        for chunk in iter(lambda:fetched['Body'].read(1024*1024),b''):
            size+=len(chunk); hashed.update(chunk)
        if hashed.hexdigest()!=checksum or size!=path.stat().st_size or fetched.get('Metadata',{}).get('sha256')!=checksum:
            raise ValueError('remote_checksum_mismatch')
    finally:
        fetched['Body'].close()
    return {'key':key,'version_id':version,'sha256':checksum,'bytes':size}


def encrypt_json(value, output, recipients):
    with output.open('xb') as file:
        result = subprocess.run(['age','-R',str(recipients)],input=json.dumps(value).encode(),stdout=file,stderr=subprocess.DEVNULL)
    if result.returncode: raise ValueError('metadata_encryption_failed')


def upload_set(s3,bucket,scope,files,recipients,stage,now,run_id,source_time):
    if scope not in ('database','retell') or not re.fullmatch(r'[A-Za-z0-9-]{1,100}',run_id):
        raise ValueError('invalid_scope_or_run_id')
    promoted=classes(s3,bucket,scope,now)
    # No success marker at all until every required class has verified files.
    sets=[]
    for kind in promoted:
        prefix=f'{kind}/{scope}/{period(now,kind)}/{run_id}/'
        objects=[put_verified(s3,bucket,prefix+file.name,file,RETENTION[kind]) for file in files]
        sets.append((kind,prefix,objects))
    receipt={'state':'verified','scope':scope,'completed_at':dt.datetime.now(UTC).isoformat(),
             'source_time':source_time,'run_id':run_id,'retention_classes':promoted,
             'sets':[{'class':kind,'objects':objects} for kind,_,objects in sets]}
    path=stage/'receipt.json.age'
    encrypt_json(receipt,path,recipients)
    # Hourly marker last, to avoid a green freshness signal on promotion failure.
    for kind,prefix,_ in sorted(sets,key=lambda x:x[0]=='hourly'):
        put_verified(s3,bucket,prefix+path.name,path,RETENTION[kind],
            {'state':'verified','scope':scope,'completed-at':receipt['completed_at'],
             'source-time':source_time,'run-id':run_id})
    return receipt


def freshness(s3,bucket,scope='database',minutes=75):
    now=dt.datetime.now(UTC)
    times=[]
    for day in (now,now-dt.timedelta(days=1)):
        prefix=f'hourly/{scope}/{day.strftime("%Y-%m-%d")}/'
        for page in s3.get_paginator('list_objects_v2').paginate(Bucket=bucket,Prefix=prefix):
            for item in page.get('Contents',[]):
                if item['Key'].endswith('/receipt.json.age'):
                    meta=s3.head_object(Bucket=bucket,Key=item['Key']).get('Metadata',{})
                    if meta.get('state')=='verified':
                        value=dt.datetime.fromisoformat(meta['source-time'])
                        if value.tzinfo is None: raise ValueError('invalid_receipt_time')
                        times.append(value)
    if not times or max(times)>now+dt.timedelta(minutes=1) or now-max(times)>dt.timedelta(minutes=minutes):
        raise ValueError('backup_stale_or_missing')
    return max(times).isoformat()
