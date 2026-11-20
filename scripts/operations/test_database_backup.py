import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import database_backup as backup


class BackupSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.recipients = self.root / 'recipients'
        self.recipients.write_text('age1synthetic-public-key\n', encoding="utf-8")
        self.password = self.root / 'pgpass'
        self.password.write_text('DO_NOT_LOG_PASSWORD', encoding="utf-8")
        self.password.chmod(0o600)
        self.env = patch.dict(os.environ, {'PGHOST': 'db.example.test', 'PGUSER': 'postgres',
            'PGDATABASE': 'postgres', 'PGSSLMODE': 'verify-full', 'PGPASSFILE': str(self.password),
            'BACKUP_DESTINATION_APPROVED': 'yes'}, clear=True)
        self.env.start()
        self.tools = patch.object(backup.shutil, 'which', return_value='/synthetic/tool')
        self.tools.start()
        self.catalog = patch.object(backup.subprocess, 'run', return_value=type('Result', (), {
            'returncode':0, 'stdout':b'{"schemas":["public","auth","storage","supabase_migrations","extensions","vault","realtime"],"vault_count":0,"extensions":["pgcrypto"],"server_version":"17.6"}'})())
        self.catalog.start()

    def tearDown(self):
        self.catalog.stop(); self.tools.stop(); self.env.stop(); self.temp.cleanup()

    def test_new_persistent_schema_requires_review(self):
        result = type('Result', (), {'returncode':0, 'stdout':b'{"schemas":["public","billing"],"vault_count":0,"extensions":[]}'})()
        with patch.object(backup.subprocess, 'run', return_value=result):
            with self.assertRaises(ValueError): backup.backup(self.root, self.recipients)
        self.assertFalse(list(self.root.glob('.pending-*')))

    def test_unapproved_destination_refused(self):
        os.environ.pop('BACKUP_DESTINATION_APPROVED')
        with self.assertRaises(ValueError): backup.backup(self.root, self.recipients)
        self.assertFalse(list(self.root.glob('.pending-*')))

    def test_unsafe_password_file_refused(self):
        self.password.chmod(0o644)
        with self.assertRaises(ValueError): backup.backup(self.root, self.recipients)

    def test_unverified_tls_refused(self):
        os.environ['PGSSLMODE'] = 'require'
        with self.assertRaises(ValueError): backup.backup(self.root, self.recipients)

    def test_pipeline_failure_cleans_partial_and_logs_no_secrets(self):
        def failure(commands, output):
            output.write_bytes(b'partial ciphertext')
            raise ValueError('DO_NOT_LOG_PASSWORD')
        with patch.object(backup, 'pipeline', side_effect=failure):
            with self.assertRaises(ValueError): backup.backup(self.root, self.recipients)
        self.assertFalse(list(self.root.glob('.pending-*')))
        self.assertFalse(list(self.root.glob('*/database.dump.age')))

    def test_bundle_scope_checksum_and_no_overwrite(self):
        commands = []
        def fake(command, output):
            commands.append(command)
            output.write_bytes(b'synthetic ciphertext; not encryption test')
        with patch.object(backup, 'pipeline', side_effect=fake), contextlib.redirect_stdout(io.StringIO()):
            first = backup.backup(self.root, self.recipients)
            second = backup.backup(self.root, self.recipients)
        self.assertNotEqual(first, second)
        manifest = json.loads((first / 'manifest.json').read_text(encoding="utf-8"))
        self.assertFalse(manifest['restore_tested'])
        self.assertFalse(manifest['archive_validated'])
        self.assertEqual(manifest['files']['database.dump.age']['sha256'], backup.digest(first / 'database.dump.age'))
        self.assertIn('auth', manifest['schemas'])
        self.assertNotIn('vault', manifest['schemas'])
        self.assertIn('--no-role-passwords', commands[1][0])
        self.assertNotIn('DO_NOT_LOG_PASSWORD', str(commands))

    def test_tampered_ciphertext_refused_before_decrypt(self):
        with patch.object(backup, 'pipeline', side_effect=lambda commands,path:path.write_bytes(b'ciphertext')), contextlib.redirect_stdout(io.StringIO()):
            bundle = backup.backup(self.root, self.recipients)
        (bundle / 'database.dump.age').write_bytes(b'tampered')
        with patch.object(backup.subprocess, 'Popen') as start:
            with self.assertRaises(ValueError): backup.verify(bundle, self.password)
            start.assert_not_called()

    def test_real_pipeline_checks_upstream_failure(self):
        with self.assertRaises(ValueError):
            backup.pipeline([[sys.executable, '-c', 'import sys;sys.stdout.write("partial");sys.exit(7)'],
                             [sys.executable, '-c', 'import sys;sys.stdout.write(sys.stdin.read())']], self.root / 'output')

    def test_real_pipeline_refuses_overwrite(self):
        output = self.root / 'output'; output.write_bytes(b'existing')
        with self.assertRaises(FileExistsError): backup.pipeline([[sys.executable, '-c', 'print(1)']], output)
        self.assertEqual(output.read_bytes(), b'existing')


if __name__ == '__main__':
    unittest.main()
