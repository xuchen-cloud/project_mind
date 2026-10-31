#!/usr/bin/env python3
"""Create a detached baseline worktree and transplant only the current replay tests."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('destination', type=Path)
parser.add_argument('--revision', default='3b9fd80')
args = parser.parse_args()
root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
relative = Path('src-tauri/src/voice/activity.rs')
current = (root / relative).read_text()
marker = '#[cfg(test)]\nmod tests {'
assert current.count(marker) == 1
subprocess.run(['git', 'worktree', 'add', '--detach', str(args.destination), args.revision], check=True)
target = args.destination / relative
baseline = target.read_text()
assert baseline.count(marker) == 1
target.write_text(baseline.split(marker)[0] + marker + current.split(marker)[1])
print('Prepared detached baseline with current activity tests; no build or benchmark was run.')
print('Build sequentially with CARGO_TARGET_DIR shared with the main checkout; copy the produced test binary before building after.')
