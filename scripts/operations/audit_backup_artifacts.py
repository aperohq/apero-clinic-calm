#!/usr/bin/env python3
"""Audit all reachable Git blobs and working files; print paths/categories only.
Heuristics flag candidates for private review, not proof of patient content.
No rewrite, deletion, or file contents in output.
"""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
SKIP = {'.git', 'node_modules', '.output', 'dist', '.tanstack', '.vinxi', '__pycache__'}
PATTERNS = {
    'private_key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'provider_secret': rb'\b(?:sb_secret_[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,})\b',
    'jwt_literal': rb'eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}',
    'postgres_dump': rb'(?:PostgreSQL database dump|^COPY (?:public|auth)\.[^\n]+ FROM stdin|^PGDMP)',
    'credential_assignment': rb'''(?i)(?:password|service_role_key|retell_api_key|access_token)\s*[=:]\s*["']([A-Za-z0-9_./+=-]{24,})["']''',
}
SUSPECT = re.compile(r'(?i)(?:\.(?:dump|backup|sql\.gz|csv|pgpass|pem|key)$|(?:^|/)(?:backups|database-backups)/|(?:production|prod)[-_].*\.json$)')
EXPORT = re.compile(r'(?i)(?:retell/acceptance/.*(?:results|traces|remote|flow)|(?:evidence|response|export|snapshot).*\.json$)')


def findings(path, body):
    flags = [name for name, pattern in PATTERNS.items() if re.search(pattern, body, re.M)]
    if SUSPECT.search(path):
        flags.append('artifact_filename')
    if EXPORT.search(path):
        flags.append('json_export_review')
    if Path(path).name.startswith('.env'):
        flags.append('environment_file_review')
    return sorted(flags)


records = subprocess.check_output(['git', 'rev-list', '--objects', '--all'], cwd=ROOT).splitlines()
process = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
found = []
blobs = 0
try:
    for record in records:
        parts = record.split(b' ', 1)
        if len(parts) != 2:
            continue
        oid, rawpath = parts
        process.stdin.write(oid + b'\n'); process.stdin.flush()
        header = process.stdout.readline().split()
        size = int(header[2])
        body = process.stdout.read(size)
        process.stdout.read(1)
        if header[1] != b'blob':
            continue
        blobs += 1
        path = rawpath.decode(errors='replace')
        flags = findings(path, body)
        if flags:
            found.append({'scope': 'reachable_history', 'oid': oid.decode(), 'path': path, 'flags': flags})
finally:
    process.stdin.close(); process.wait()
files = 0
for path in ROOT.rglob('*'):
    relative = path.relative_to(ROOT)
    if any(part in SKIP for part in relative.parts) or path.is_symlink() or not path.is_file():
        continue
    files += 1
    flags = findings(str(relative), path.read_bytes())
    if flags:
        found.append({'scope': 'working_tree', 'path': str(relative), 'flags': flags})
print(json.dumps({'reachable_blobs_scanned': blobs, 'working_files_scanned': files,
                  'findings': found, 'limitations': 'Heuristic candidates; synthetic fixtures and code examples require review. No patient values printed.'}, indent=2))
