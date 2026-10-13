"""Recheck already-produced main-agent browser candidates, without launching UI."""
from pathlib import Path
import json,sys
from verify import verify, ROOT
rows=[]
for browser in ['chromium','webkit']:
 for case in ['simple','complex']:
  candidate=ROOT/'browser/output'/browser/(case+'.browser-edited.docx')
  result=verify(case,'edited','real Tiptap Editor → keyboard selection edits → getJSON → pmDocToSavePlan → saveDocx',candidate)
  result['browser']=browser
  rows.append(result)
  print(browser,case,result['status'],len(result['checks']))
(ROOT/'browser-results.json').write_text(json.dumps({'execution_owner':'main agent','interaction_evidence':'main-agent-browser-report.json','results':rows},ensure_ascii=False,indent=2))
if any(x['status']!='passed' for x in rows):sys.exit(1)
