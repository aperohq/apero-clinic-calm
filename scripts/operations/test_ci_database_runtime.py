"""Synthetic CI plumbing only; no database, AWS, provider or secret-manager access."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import ci_backup as ci


def fixture():
    return {
        'format_version': 1,
        'supabase_settings': {
            'INTEGRATION_ENCRYPTION_KEY': 'a' * 64,
            'INTEGRATION_WORKER_SECRET': 'b' * 64,
            'GOOGLE_CLIENT_ID': 'synthetic-client',
            'GOOGLE_CLIENT_SECRET': 'SYNTHETIC_DO_NOT_LOG',
            'GOOGLE_REDIRECT_URI': 'https://example.supabase.co/functions/v1/integration-api/oauth/google/callback',
            'GOOGLE_WEBHOOK_URI': 'https://example.supabase.co/functions/v1/google-calendar-webhook',
            'INTEGRATIONS_ENABLED': 'true',
        },
        'vault_settings': {
            'apero_integration_worker_secret': 'b' * 64,
            'apero_integration_worker_url': 'https://example.supabase.co/functions/v1/integration-worker',
        },
        'worker_schedule': {
            'connection_id': '00000000-0000-4000-8000-000000000001',
            'calendar_id': 'synthetic123@group.calendar.google.com',
            'schedule': '* * * * *',
        },
        'restore_requires_disabled_flags_until_acceptance': True,
    }


class DatabaseRuntimeCI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='apero-ci-runtime-test-')
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.environment = patch.dict(os.environ, {'BACKUP_S3_BUCKET': 'synthetic-bucket'}, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.temp.cleanup)
        os.environ.pop('INTEGRATION_RECOVERY_CONFIG', None)
        self.recipients = self.root / 'recipients'
        self.recipients.write_text('age1synthetic\n', encoding="utf-8")
        self.recipients.chmod(0o600)
        self.identity = self.root / 'identity'
        self.identity.write_text('synthetic', encoding="utf-8")
        self.identity.chmod(0o600)

    def run_database(self):
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def execute(self, *_): return self
            def fetchone(self): return ('synthetic-snapshot',)

        seen = {}

        def backup(output, *_):
            config = ci.db.integration_recovery_config(os.environ.get('INTEGRATION_RECOVERY_CONFIG', ''))
            seen['ciphertext_only'] = config.read_bytes().startswith(b'age-encryption.org/v1\n')
            seen['source_env_removed'] = 'BACKUP_INTEGRATION_RECOVERY_JSON' not in os.environ
            bundle = output / 'synthetic-bundle'
            bundle.mkdir(mode=0o700)
            files = {}
            for name in ['database.dump.age', 'roles.sql.age', 'integration-settings.json.age']:
                (bundle / name).write_bytes(config.read_bytes())
                files[name] = {'bytes': config.stat().st_size, 'sha256': ci.db.digest(config)}
            (bundle / 'manifest.json').write_text(json.dumps({
                'files': files, 'catalog': {'integration_runtime_recovery': 'synthetic review'},
            }), encoding="utf-8")
            return bundle

        def encrypt(value, output, _):
            output.write_bytes(b'age-encryption.org/v1\nsynthetic-manifest')

        def encrypt_config(command, **options):
            self.assertNotIn('SYNTHETIC_DO_NOT_LOG', str(command))
            self.assertNotIn('BACKUP_INTEGRATION_RECOVERY_JSON', options.get('env', {}))
            options['stdout'].write(b'age-encryption.org/v1\nsynthetic-encrypted-config')
            return SimpleNamespace(returncode=0)

        with patch.dict(sys.modules, {'psycopg': SimpleNamespace(connect=lambda _: Connection())}), \
             patch.object(ci, 'setup', return_value=(self.recipients, self.identity)), \
             patch.object(ci, 'snapshot_catalog', return_value={}), \
             patch.object(ci.storage, 'client', return_value=object()), \
             patch.object(ci.storage, 'check_bucket'), \
             patch.object(ci.storage, 'encrypt_json', side_effect=encrypt), \
             patch.object(ci.storage, 'upload_set', return_value={'retention_classes': ['hourly']}) as upload, \
             patch.object(ci.db, 'backup', side_effect=backup), \
             patch.object(ci.db, 'verify'), \
             patch.object(ci.subprocess, 'run', side_effect=encrypt_config), \
             contextlib.redirect_stdout(io.StringIO()) as logs:
            ci.run('database')
        self.assertTrue(seen['ciphertext_only'])
        self.assertTrue(seen['source_env_removed'])
        self.assertEqual(upload.call_count, 1)
        self.assertNotIn('SYNTHETIC_DO_NOT_LOG', logs.getvalue())

    def test_ci_materializes_reviewed_runtime_for_ephemeral_verification(self):
        os.environ['BACKUP_INTEGRATION_RECOVERY_JSON'] = json.dumps(fixture())
        self.run_database()

    def test_missing_runtime_input_cannot_be_uploaded_as_success(self):
        os.environ.pop('BACKUP_INTEGRATION_RECOVERY_JSON', None)
        with self.assertRaisesRegex(ValueError, 'private_path_required'):
            self.run_database()

    def test_malformed_duplicate_oversized_and_wrong_shapes_fail_safely(self):
        invalid = ['SYNTHETIC_DO_NOT_LOG', '{"format_version":1,"format_version":1}',
                   ' ' * 32769, '[]', 'null', '{}']
        for raw in invalid:
            with self.subTest(kind=raw[:2]), self.assertRaisesRegex(ValueError, '^invalid_integration_recovery_json$'):
                ci.reviewed_database_runtime(raw)

    def test_unreviewed_scope_and_unsafe_restore_values_rejected(self):
        changes = [
            lambda value: value.update(format_version=True),
            lambda value: value.update(restore_requires_disabled_flags_until_acceptance=False),
            lambda value: value['supabase_settings'].update(UNREVIEWED_SETTING='unknown'),
            lambda value: value['supabase_settings'].update(INTEGRATION_ENCRYPTION_KEY='bad'),
            lambda value: value['vault_settings'].update(apero_integration_worker_secret='different'),
            lambda value: value['vault_settings'].update(apero_integration_worker_url='http://example.supabase.co/functions/v1/integration-worker'),
            lambda value: value['supabase_settings'].update(GOOGLE_REDIRECT_URI='https://foreign.example/callback'),
            lambda value: value['worker_schedule'].update(connection_id='not-a-uuid'),
            lambda value: value['worker_schedule'].update(calendar_id='primary'),
            lambda value: value['worker_schedule'].update(schedule='* * * * *; SELECT 1'),
            lambda value: value['supabase_settings'].update(GOOGLE_CLIENT_SECRET='bad\nSYNTHETIC_DO_NOT_LOG'),
        ]
        for index, change in enumerate(changes):
            value = fixture()
            change(value)
            with self.subTest(case=index), self.assertRaisesRegex(ValueError, '^invalid_integration_recovery_json$'):
                ci.reviewed_database_runtime(json.dumps(value))

    def test_partial_ciphertext_cleanup_and_old_pointer_restored(self):
        prior = '/synthetic/prior-config.age'
        os.environ['INTEGRATION_RECOVERY_CONFIG'] = prior
        def fail(*_, **options):
            options['stdout'].write(b'partial')
            return SimpleNamespace(returncode=7)
        with patch.object(ci.subprocess, 'run', side_effect=fail):
            with self.assertRaisesRegex(ValueError, 'integration_recovery_encryption_failed'):
                with ci.database_runtime_input(self.root, self.recipients, json.dumps(fixture())):
                    self.fail('Failed encryption must never yield to database backup')
        self.assertFalse((self.root / 'integration-settings.json.age').exists())
        self.assertEqual(os.environ['INTEGRATION_RECOVERY_CONFIG'], prior)

    def test_existing_ciphertext_is_not_overwritten_or_deleted(self):
        path = self.root / 'integration-settings.json.age'
        path.write_bytes(b'preserved-existing')
        with self.assertRaises(FileExistsError):
            with ci.database_runtime_input(self.root, self.recipients, json.dumps(fixture())):
                self.fail('Existing destination cannot be used')
        self.assertEqual(path.read_bytes(), b'preserved-existing')

    def test_missing_or_malformed_input_reports_failure_without_secret_values(self):
        with patch.object(sys, 'argv', ['ci_backup.py', '--mode', 'database']), \
             patch.object(ci, 'run', side_effect=ValueError('SYNTHETIC_DO_NOT_LOG')), \
             contextlib.redirect_stdout(io.StringIO()) as logs:
            self.assertEqual(ci.main(), 1)
        self.assertNotIn('SYNTHETIC_DO_NOT_LOG', logs.getvalue())
        report = json.loads(logs.getvalue())
        self.assertEqual(report['state'], 'failure')

    @unittest.skipUnless(shutil.which('age') and shutil.which('age-keygen'), 'Local age tools required for genuine dual-recipient encryption')
    def test_genuine_ciphertext_decrypts_for_custodian_and_ephemeral_verifier(self):
        identities = []
        recipients = []
        for name in ['custodian', 'ephemeral']:
            identity = self.root / name
            subprocess.run(['age-keygen', '-o', str(identity)], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=True)
            identity.chmod(0o600)
            recipient = subprocess.check_output(['age-keygen', '-y', str(identity)], stderr=subprocess.DEVNULL).decode().strip()
            identities.append(identity)
            recipients.append(recipient)
        self.recipients.write_text('\n'.join(recipients) + '\n', encoding="utf-8")
        raw = json.dumps(fixture())
        with contextlib.redirect_stdout(io.StringIO()) as logs:
            with self.assertRaisesRegex(RuntimeError, 'synthetic interrupted backup'):
                with ci.database_runtime_input(self.root, self.recipients, raw):
                    path = Path(os.environ['INTEGRATION_RECOVERY_CONFIG'])
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                    self.assertNotIn(b'SYNTHETIC_DO_NOT_LOG', path.read_bytes())
                    for identity in identities:
                        value = subprocess.check_output(['age', '-d', '-i', str(identity), str(path)], stderr=subprocess.DEVNULL)
                        self.assertEqual(json.loads(value), fixture())
                    raise RuntimeError('synthetic interrupted backup')
        self.assertFalse(path.exists())
        self.assertNotIn('INTEGRATION_RECOVERY_CONFIG', os.environ)
        self.assertNotIn('SYNTHETIC_DO_NOT_LOG', logs.getvalue())


if __name__ == '__main__':
    unittest.main()
