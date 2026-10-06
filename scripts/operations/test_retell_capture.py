import unittest
from unittest.mock import patch
import retell_config_backup as retell

class ConfigTests(unittest.TestCase):
    def test_only_configuration_endpoints_and_two_versions(self):
        paths=[]
        def api(path):
            paths.append(path)
            if path.startswith('get-agent/'):
                return {'agent_id':'agent_fixture','version':1,'opt_in_signed_url':True,'signed_url_expiration_ms':1060000,'language':['ar-SA','en-US'],'voice_id':'custom_voice_fixture',
                        'response_engine':{'conversation_flow_id':'conversation_flow_fixture','version':1}}
            if path.startswith('get-conversation-flow/'):
                return {'knowledge_base_ids':['knowledge_base_fixture'],'tools':[{'name':'resolve_service'}]}
            if path.startswith('get-knowledge-base/'):
                return {'knowledge_base_id':'knowledge_base_fixture','knowledge_base_sources':[]}
            raise AssertionError('Unexpected endpoint')
        with patch.object(retell,'api',side_effect=api):x=retell.capture(['agent_fixture'])
        self.assertEqual(len(x['agents']),2)
        self.assertTrue(x['agents'][0]['opt_in_signed_url'])
        self.assertEqual(x['agents'][0]['signed_url_expiration_ms'],1060000)
        self.assertTrue(all(p.startswith(('get-agent/','get-conversation-flow/','get-knowledge-base/')) for p in paths))
        self.assertFalse(any('list-calls' in p or 'get-call' in p for p in paths))
    def test_invalid_agent_never_requested(self):
        with patch.object(retell,'api') as api:
            with self.assertRaises(ValueError):retell.capture(['../../get-call'])
            api.assert_not_called()

if __name__=='__main__':unittest.main()
