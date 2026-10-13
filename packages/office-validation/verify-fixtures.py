"""Verify archived original checksums without regenerating or modifying files."""
from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parent
for fmt, metadata, group, field in [
    ('docx', 'fixtures.json', 'cases', 'path'),
    ('xlsx', 'fixtures.json', 'samples', 'file'),
    ('pptx', 'manifest.json', 'samples', 'path'),
]:
    manifest = json.loads((ROOT / fmt / metadata).read_text())
    for kind, sample in manifest[group].items():
        file = ROOT / fmt / sample[field]
        actual = hashlib.sha256(file.read_bytes()).hexdigest()
        if actual != sample['sha256']:
            raise SystemExit(f'{fmt}/{kind}: original checksum mismatch')
        print(f'{fmt}/{file.name}: checksum verified')
