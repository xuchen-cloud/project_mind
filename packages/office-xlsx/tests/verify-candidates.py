"""Independent, read-only openpyxl/lxml/ZIP verification of engine candidates."""
from pathlib import Path
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / 'fixtures'))
from verify import verify_candidate

manifest = json.loads((ROOT / 'fixtures/fixtures.json').read_text())
report = {'validator': 'openpyxl + lxml + raw ZIP compressed payload hashes', 'runs': []}
for kind in ['simple', 'complex']:
    model = json.loads((ROOT / f'output/{kind}.model.json').read_text())
    result = verify_candidate(kind, ROOT / f'output/{kind}.xlsx', sdk={
        'metadata': {'sheets': model['sheets']}, 'ranges': model['ranges'],
    })
    original = (ROOT / f'fixtures/{kind}.original.xlsx').read_bytes()
    assert hashlib.sha256(original).hexdigest() == manifest['samples'][kind]['sha256']
    report['runs'].append({'fixture': kind, **result})
    print(f"{kind}: {result['passed_assertions']}/{result['assertions']} checks passed")
    assert not result['failures'], json.dumps(result['failures'], ensure_ascii=False, default=str)
(ROOT / 'output/independent-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str) + '\n')
