"""Compatibility entry point; fetch-core.py now fetches both locks by default."""
from pathlib import Path
import subprocess,sys
subprocess.run([sys.executable,str(Path(__file__).with_name('fetch-core.py')),'--group','extra',*sys.argv[1:]],check=True)
