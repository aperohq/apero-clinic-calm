import unittest
from unittest.mock import patch
import restore_drill

class RestorePrerequisites(unittest.TestCase):
    def test_extension_schema_from_manifest_and_legacy_default(self):
        for catalog, expected in [({'extensions':['btree_gist']}, '"public"'),
            ({'extensions':['btree_gist'], 'extension_schemas':{'btree_gist':'extensions'}}, '"extensions"')]:
            with patch.object(restore_drill, 'execute') as execute:
                restore_drill.prepare_extensions(['isolated-psql'], catalog)
                self.assertIn(b'create extension if not exists btree_gist', execute.call_args.kwargs['input'])
                self.assertIn(expected.encode(), execute.call_args.kwargs['input'])
    def test_untrusted_extension_schema_refused(self):
        with self.assertRaises(ValueError):
            restore_drill.prepare_extensions([], {'extensions':['btree_gist'], 'extension_schemas':{'btree_gist':'public; drop database x'}})
    def test_restore_order(self):
        phases = []
        with patch.object(restore_drill, 'stream', side_effect=lambda identity, archive, command: phases.append(command[-1])), patch.object(restore_drill, 'prepare_extensions', side_effect=lambda psql, catalog: phases.append('extensions')):
            restore_drill.restore_archive_sections('synthetic-key', 'synthetic-archive', ['psql'], ['pg_restore'], {})
        self.assertEqual(phases, ['--section=pre-data', 'extensions', '--section=post-data'])
