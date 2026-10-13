"""Independent default WHEN_EMPTY diagnostic; retains failures in its result."""
import json
from compare import ROOT, compare

result = compare(ROOT / 'simple.original.xlsx', ROOT / 'simple.unit.edited-default.xlsx', True)
(ROOT / 'default-calculation-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
print(json.dumps({'status': result['status'], 'failures': [c['name'] for c in result['failures']]}, ensure_ascii=False))
raise SystemExit(1 if result['status'] == 'failed' else 0)
