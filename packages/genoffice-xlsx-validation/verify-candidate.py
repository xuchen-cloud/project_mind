import argparse, json
from pathlib import Path
from verify import verify_candidate
p=argparse.ArgumentParser()
p.add_argument('--kind',choices=['simple','complex'],required=True)
p.add_argument('--noop',action='store_true')
p.add_argument('candidate',type=Path)
p.add_argument('--output',type=Path)
p.add_argument('--sdk-events',type=Path,help='Browser backend events JSON with sdk from real sidecar reopen')
a=p.parse_args()
sdk=json.loads(a.sdk_events.read_text())['sdk'] if a.sdk_events else None
result=verify_candidate(a.kind,a.candidate,not a.noop,sdk=sdk)
output=a.output or a.candidate.with_suffix('.verification.json')
output.write_text(json.dumps(result,ensure_ascii=False,indent=2,default=str)+'\n')
print(json.dumps({'status':result['status'],'assertions':result['assertions'],'failures':[c['name'] for c in result['failures']],'output':str(output)},ensure_ascii=False))
raise SystemExit(0 if result['status']=='passed' else 1)
