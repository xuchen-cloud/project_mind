"""Collector-only checks; the synthetic database is not native acceptance evidence."""
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


class SnapshotTest(unittest.TestCase):
    def test_read_only_fixture_and_escape_rejection(self):
        with tempfile.TemporaryDirectory(prefix='file-flow-collector-') as temporary:
            root = Path(temporary)
            directory = root / 'workspace' / '.project-mind'
            directory.mkdir(parents=True)
            database = directory / 'workspace.sqlite3'
            with sqlite3.connect(database) as db:
                db.executescript('''
                    CREATE TABLE documents(id,project_id,name,current_version_number,managed_path);
                    CREATE TABLE file_working_contents(document_id,state,bytes);
                    CREATE TABLE file_working_sessions(document_id,session_id);
                    CREATE TABLE document_versions(id,document_id,version_number,display_name,is_important,metadata_revision);
                    CREATE TABLE source_file_version_hashes(document_version_id,content_hash);
                    INSERT INTO documents VALUES(1,2,'sample.md',1,'sample.md');
                    INSERT INTO file_working_sessions VALUES(1,'session');
                    INSERT INTO document_versions VALUES(10,1,1,'Label',1,3);
                    INSERT INTO source_file_version_hashes VALUES(10,'sha256:fixture');
                ''')
                db.execute('INSERT INTO file_working_contents VALUES(?,?,?)', (1, '{"revision":2}', b'draft'))
            before = hashlib.sha256(database.read_bytes()).digest()
            helper = Path(__file__).with_name('snapshot.py')

            def read(target, ids='[1]'):
                return subprocess.run([sys.executable, str(helper), str(target), ids], capture_output=True, text=True)

            result = read(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            file = json.loads(result.stdout)['1']
            self.assertEqual(file['working'], {'state': {'revision': 2}, 'text': 'draft'})
            self.assertEqual(file['sessions'], ['session'])
            self.assertEqual(file['versions'][0]['metadata_revision'], 3)
            self.assertEqual(hashlib.sha256(database.read_bytes()).digest(), before)
            self.assertNotEqual(read(root, '[true]').returncode, 0)
            escaped = root / 'nested'
            escaped.mkdir()
            (escaped / 'workspace').symlink_to(root / 'workspace', target_is_directory=True)
            self.assertNotEqual(read(escaped).returncode, 0)


if __name__ == '__main__':
    unittest.main()
