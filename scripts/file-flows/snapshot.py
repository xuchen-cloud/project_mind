"""Read only the runner-owned fresh SQLite fixture, never mutate native state."""
import json
import pathlib
import sqlite3
import sys

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
database = (root / 'workspace' / '.project-mind' / 'workspace.sqlite3').resolve(strict=True)
if not database.is_relative_to(root):
    raise SystemExit('Fixture database escaped isolated root')
ids = json.loads(sys.argv[2])
if not isinstance(ids, list) or not 1 <= len(ids) <= 8 or any(type(i) is not int or i <= 0 for i in ids):
    raise SystemExit('Expected 1..8 positive fixture IDs')
db = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5)
db.row_factory = sqlite3.Row
db.execute('PRAGMA query_only=ON')
db.execute('BEGIN')
result = {}
for document_id in ids:
    document = db.execute('SELECT id,project_id,name,current_version_number,managed_path FROM documents WHERE id=?', (document_id,)).fetchone()
    working = db.execute('SELECT state,bytes FROM file_working_contents WHERE document_id=?', (document_id,)).fetchone()
    sessions = db.execute('SELECT session_id FROM file_working_sessions WHERE document_id=? ORDER BY session_id', (document_id,)).fetchall()
    versions = db.execute('SELECT v.id,v.version_number,h.content_hash,v.display_name,v.is_important,v.metadata_revision FROM document_versions v LEFT JOIN source_file_version_hashes h ON h.document_version_id=v.id WHERE v.document_id=? ORDER BY v.version_number', (document_id,)).fetchall()
    result[str(document_id)] = {
        'document': dict(document) if document else None,
        'working': {'state': json.loads(working['state']), 'text': bytes(working['bytes']).decode('utf-8')} if working else None,
        'sessions': [row['session_id'] for row in sessions],
        'versions': [dict(row) for row in versions],
    }
db.close()
print(json.dumps(result, ensure_ascii=False))
