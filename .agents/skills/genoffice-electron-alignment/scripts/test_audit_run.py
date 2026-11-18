"""Isolated behavioral checks; no real projects, devices, network or dependency installs."""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).with_name('audit_run.py').resolve()


class AuditRunTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='alignment-workflow-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.project, self.baseline, self.corpus = [self.root / name for name in ('project with spaces', 'baseline', '测试课件')]
        for folder in (self.project, self.baseline, self.corpus):
            folder.mkdir()
        (self.project / 'app.ts').write_text('target', encoding='utf-8')
        (self.baseline / 'app.ts').write_text('baseline', encoding='utf-8')
        self.run_dir = self.root / 'run'

    def call(self, *args, expected=0):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def init(self, mode='audit', out=None, expected=0):
        return self.call('init', '--project', self.project, '--baseline', self.baseline, '--corpus', self.corpus,
                         '--out', out or self.run_dir, '--version', 'v1.2.3', '--release-url', 'https://example.invalid/release',
                         '--mode', mode, '--accepted', 'W05', expected=expected)

    def load(self, name):
        return json.loads((self.run_dir / name).read_text(encoding='utf-8'))

    def test_inventory_keeps_aliases_and_does_not_invent_rendered_pages(self):
        with zipfile.ZipFile(self.corpus / 'deck.pptx', 'w') as archive:
            archive.writestr('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="200" r:id="rId2"/><p:sldId id="100" r:id="rId1"/></p:sldIdLst></p:presentation>')
        with zipfile.ZipFile(self.corpus / 'word.docx', 'w') as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:tbl/><w:sectPr/></w:body></w:document>')
        (self.corpus / '加密.docx').write_bytes(bytes.fromhex('d0cf11e0a1b11ae1'))
        (self.corpus / 'unknown.pdf').write_bytes(b'%PDF-1.7\n')
        (self.corpus / 'note.md').write_text('same', encoding='utf-8')
        (self.corpus / '副本.md').write_text('same', encoding='utf-8')
        self.init()
        manifest, inventory = self.load('run.json'), self.load('inventory.json')
        self.assertEqual(manifest['version_verification']['status'], 'pending')
        self.assertEqual(manifest['display_acceptance'], 'not_evaluated')
        self.assertEqual(inventory['regular_file_count'], 6)
        self.assertEqual(inventory['unique_content_count'], 5)
        files = {item['path']: item for item in inventory['files']}
        ppt = files['deck.pptx']['logical_index']
        self.assertEqual([unit['relationship_id'] for unit in ppt['units']], ['rId2', 'rId1'])
        self.assertFalse(ppt['rendered'])
        word = files['word.docx']['logical_index']
        self.assertEqual(word['count'], 2)
        self.assertIsNone(word['physical_pages'])
        self.assertEqual(files['加密.docx']['logical_index']['status'], 'pending')
        self.assertIsNone(files['unknown.pdf']['logical_index']['physical_pages'])
        self.assertEqual(sum(bool(item.get('same_content_as')) for item in inventory['files']), 1)

    def test_audit_detects_input_and_target_source_changes_and_retains_history(self):
        (self.corpus / 'course.txt').write_text('initial')
        self.init()
        self.call('verify', '--run', self.run_dir)
        (self.corpus / 'course.txt').write_text('changed')
        (self.corpus / 'new.txt').write_text('added')
        (self.baseline / 'app.ts').unlink()
        (self.project / 'app.ts').write_text('accidental audit modification')
        self.call('verify', '--run', self.run_dir, expected=1)
        result = self.load('integrity.json')
        self.assertFalse(result['protected_inputs_unchanged'])
        self.assertEqual(result['display_acceptance'], 'not_evaluated')
        self.assertEqual(result['changes']['baseline'][0]['change'], 'removed')
        self.assertTrue(result['changes']['project'])
        self.assertEqual({item['change'] for item in result['changes']['corpus']}, {'modified', 'added'})
        self.assertEqual(len((self.run_dir / 'integrity-history.jsonl').read_text().splitlines()), 2)

    def test_repair_allows_target_changes_but_still_protects_baseline(self):
        self.init(mode='repair')
        (self.project / 'app.ts').write_text('authorized target repair')
        self.call('verify', '--run', self.run_dir)
        (self.baseline / 'app.ts').write_text('baseline regression')
        self.call('verify', '--run', self.run_dir, expected=1)
        self.assertTrue(self.load('integrity.json')['changes']['baseline'])

    @unittest.skipUnless(shutil.which('git'), 'git required for tracked-path protection')
    def test_tracked_source_inside_generated_name_stays_protected(self):
        subprocess.run(['git', '-C', str(self.baseline), 'init', '-q'], check=True, capture_output=True)
        (self.baseline / 'dist').mkdir()
        (self.baseline / 'dist/keep.ts').write_text('tracked source')
        subprocess.run(['git', '-C', str(self.baseline), '-c', 'core.attributesFile=/dev/null', 'add', 'dist/keep.ts'], check=True, capture_output=True)
        self.init()
        (self.baseline / 'node_modules').mkdir()
        (self.baseline / 'node_modules/generated.txt').write_text('dependency artifact')
        self.call('verify', '--run', self.run_dir)
        (self.baseline / 'dist/keep.ts').write_text('changed tracked source')
        self.call('verify', '--run', self.run_dir, expected=1)
        self.assertEqual(self.load('integrity.json')['changes']['baseline'][0]['path'], 'dist/keep.ts')

    def test_existing_output_and_overlapping_output_are_refused(self):
        self.init(out=self.corpus / 'output', expected=2)
        self.assertFalse((self.corpus / 'output').exists())
        self.init(out=self.project / 'output', expected=2)
        self.init()
        before = (self.run_dir / 'run.json').read_bytes()
        self.init(expected=2)
        self.assertEqual((self.run_dir / 'run.json').read_bytes(), before)

    def test_external_symlink_is_recorded_without_following_it(self):
        secret = self.root / 'outside.txt'
        secret.write_text('not an authorized courseware input')
        try:
            (self.corpus / 'link.txt').symlink_to(secret)
        except OSError:
            self.skipTest('symlinks unavailable')
        self.init()
        item = self.load('inventory.json')['files'][0]
        self.assertEqual(item['kind'], 'symlink')
        self.assertNotIn('sha256', item)
        self.assertEqual(item['logical_index']['status'], 'pending')
        self.assertEqual(self.load('inventory.json')['regular_file_count'], 0)


if __name__ == '__main__':
    unittest.main()
