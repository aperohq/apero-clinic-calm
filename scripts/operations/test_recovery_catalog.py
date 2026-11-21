import unittest
from recovery_catalog import structures_match

class CatalogACLs(unittest.TestCase):
    def catalogs(self, expected, actual, owner='synthetic_owner'):
        before={'table_acl':[{'schema':'public','name':'fixture','owner':owner,'acl':expected}]}
        after={'table_acl':[{'schema':'public','name':'fixture','owner':owner,'acl':actual,'default_acl':'{synthetic_owner=arwdDxt/synthetic_owner}'}]}
        return before,after
    def test_legacy_explicit_owner_acl_and_implicit_default_are_equivalent(self):
        before,after=self.catalogs('{synthetic_owner=arwdDxt/synthetic_owner}',None)
        self.assertTrue(structures_match(before,after))
        self.assertNotIn('default_acl',before['table_acl'][0])
    def test_public_access_is_not_normalized_away(self):
        before,after=self.catalogs(None,'{synthetic_owner=arwdDxt/synthetic_owner,=r/synthetic_owner}')
        self.assertFalse(structures_match(before,after))
    def test_owner_change_is_rejected(self):
        before,after=self.catalogs(None,None)
        after['table_acl'][0]['owner']='different_owner'
        self.assertFalse(structures_match(before,after))
