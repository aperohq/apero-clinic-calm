"""Guard Windows text IO without changing binary backup streams."""
import ast
import json
from pathlib import Path
import tempfile
import unittest

class Utf8IO(unittest.TestCase):
    def test_arabic_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fixture.json'
            expected = {'name': 'عيادة أبيرو', 'service': 'تنظيف الأسنان'}
            path.write_text(json.dumps(expected, ensure_ascii=False), encoding='utf-8')
            self.assertEqual(json.loads(path.read_text(encoding='utf-8')), expected)

    def test_python_text_operations_are_explicit(self):
        root = Path(__file__).resolve().parents[1]
        for folder in ('scripts', 'retell', 'tests'):
            for path in (root / folder).rglob('*.py'):
                tree = ast.parse(path.read_text(encoding='utf-8'))
                for node in ast.walk(tree):
                    if not isinstance(node, ast.Call):
                        continue
                    name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ''
                    if name not in ('open', 'read_text', 'write_text'):
                        continue
                    mode = next((kw.value for kw in node.keywords if kw.arg == 'mode'), None)
                    if name == 'open' and mode is None:
                        index = 0 if isinstance(node.func, ast.Attribute) else 1
                        if len(node.args) > index:
                            mode = node.args[index]
                    if mode is not None and (not isinstance(mode, ast.Constant) or not isinstance(mode.value, str) or 'b' in mode.value):
                        continue
                    if name in ('read_text', 'write_text') and len(node.args) > (0 if name == 'read_text' else 1):
                        continue
                    self.assertTrue(any(kw.arg == 'encoding' for kw in node.keywords), f'{path.relative_to(root)}:{node.lineno}')

if __name__ == '__main__':
    unittest.main()
