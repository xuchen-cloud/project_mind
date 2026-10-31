#!/usr/bin/env python3
"""Run an already-built replay test, recording CPU/wall metrics without transcript text."""
import argparse
import json
import os
from pathlib import Path
import resource
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('binary', type=Path)
parser.add_argument('--label', required=True)
parser.add_argument('--shape', choices=['mac', 'windows'], default='mac')
parser.add_argument('--both-voiced', action='store_true')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
env = os.environ.copy()
env['PROJECT_MIND_TEST_QUEUE_CAPACITY'] = '256' if args.shape == 'windows' else '1024'
env['PROJECT_MIND_TEST_MIC_CALLBACK'] = '480' if args.shape == 'windows' else '1024'
env['PROJECT_MIND_TEST_SYSTEM_CALLBACK'] = '480'
if args.both_voiced:
    env['PROJECT_MIND_TEST_BOTH_VOICED'] = '1'
else:
    env.pop('PROJECT_MIND_TEST_BOTH_VOICED', None)
before = resource.getrusage(resource.RUSAGE_CHILDREN)
started = time.monotonic()
result = subprocess.run([
    str(args.binary.resolve()),
    'voice::activity::tests::replays_saved_audio_activity_with_live_local_at_capture_rate',
    '--exact', '--ignored', '--nocapture', '--test-threads=1',
], env=env, capture_output=True, text=True)
wall = time.monotonic() - started
after = resource.getrusage(resource.RUSAGE_CHILDREN)
# Keep only known metadata lines. Never emit arbitrary child logs or final text.
lines = [line for line in (result.stdout + result.stderr).splitlines()
         if line.startswith(('REPLAY_INTEGRITY ', 'ACTIVITY_REPLAY '))]
record = dict(label=args.label, shape=args.shape, both_voiced=args.both_voiced,
              exit_code=result.returncode, wall_s=wall,
              cpu_user_s=after.ru_utime - before.ru_utime,
              cpu_system_s=after.ru_stime - before.ru_stime,
              metadata=lines)
with args.output.open('x') as output:
    json.dump(record, output, indent=2)
    output.write('\n')
print(json.dumps(record, indent=2))
raise SystemExit(result.returncode or (0 if len(lines) == 2 else 1))
