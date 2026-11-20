#!/usr/bin/env python3
"""Encrypt current identifier-only erasure intents; verified custody BEFORE ACK.
Uses existing AWS backup destination/adapter, never changes backup schedule.
Requires an administrator for ACK; backup read credential alone cannot ACK.
"""
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"operations"))
import s3_backup as storage

def export_and_ack(connection,s3,bucket,recipients,destination,ack):
    rows=connection.execute("select id,clinic_id,resource_table,resource_key,action,occurred_at,replay_until,durable_at from public.retention_deletion_ledger where durable_at is null order by id limit 10000").fetchall()
    if not rows:return 0
    names=["id","clinic_id","resource_table","resource_key","action","occurred_at","replay_until","durable_at"]
    payload=json.dumps({"format":1,"captured_at":dt.datetime.now(dt.timezone.utc).isoformat(),
        "ledger":[dict(zip(names,map(lambda x:None if x is None else str(x),row))) for row in rows]},separators=(",",":")).encode()
    if not recipients or any(not x.startswith("age1") for x in recipients):raise ValueError("public_recipients_required")
    command=["age"]
    for recipient in recipients:command+=["-r",recipient]
    with destination.open("xb") as target:
        result=subprocess.run(command,input=payload,stdout=target,stderr=subprocess.DEVNULL)
    if result.returncode:raise ValueError("encryption_failed")
    storage.check_bucket(s3,bucket)
    key="monthly/retention-ledger/"+dt.datetime.now(dt.timezone.utc).strftime("%Y/%m/%d/")+uuid.uuid4().hex+".json.age"
    storage.put_verified(s3,bucket,key,destination,400,{"scope":"deletion-ledger","state":"verified"})
    # put_verified performs immutable upload, security checks and checksum readback.
    ack([str(row[0]) for row in rows])
    return len(rows)

def database_ack(ids, connection):
    if any(str(uuid.UUID(x))!=x for x in ids):raise ValueError("invalid_ledger_id")
    result=connection.execute("select public.retention_ack_ledger(%s::uuid[])",(ids,)).fetchone()
    if not result or result[0]!=len(ids):raise ValueError("ack_failed")
    connection.commit()

def main():
    os.umask(0o077)
    try:
        if os.environ.get("RETENTION_LEDGER_CUSTODY_APPROVED")!="true":raise ValueError("custody_disabled")
        import psycopg
        if os.environ.get("PGSSLMODE")!="verify-full":raise ValueError("verified_tls_required")
        ack_service=os.environ["RETENTION_ACK_SERVICE"]
        service_file=Path(os.environ["PGSERVICEFILE"])
        if not service_file.is_file() or service_file.stat().st_mode & 0o077:raise ValueError("private_service_file_required")
        with tempfile.TemporaryDirectory(prefix="apero-retention-",dir=os.environ.get("RUNNER_TEMP","/tmp")) as stage:
            with psycopg.connect("",service=ack_service,sslmode="verify-full") as ack_connection, psycopg.connect("") as connection:
                connection.execute("set transaction read only")
                count=export_and_ack(connection,storage.client(),os.environ["BACKUP_S3_BUCKET"],
                    os.environ["AGE_RECIPIENTS"].split(),Path(stage)/"ledger.json.age",lambda ids:database_ack(ids,ack_connection))
        print(json.dumps({"category":"retention_ledger_custody","state":"success","processed":count}))
        return 0
    except Exception:
        print(json.dumps({"category":"retention_ledger_custody","state":"failure","failure_category":"configuration_error"}))
        return 1
if __name__=="__main__":sys.exit(main())
