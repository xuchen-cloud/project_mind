import json, time
from pathlib import Path
from compare import ROOT
start=time.perf_counter()
manifest=json.loads((ROOT/'fixtures.json').read_text())
sdk=json.loads((ROOT/'sdk-results.json').read_text())
reports=[]
for run in sdk['runs']:
    if 'output' not in run: continue
    candidate=(ROOT/Path(run['output']['file'])).with_suffix('.reimported.json')
    unit=json.loads(candidate.read_text())
    checks=[]
    expected_sheets=manifest['samples'][run['kind']]['sheets']
    sheets=[unit['sheets'][i] for i in unit['sheetOrder']]
    checks.append({'name':'sheet_order','passed':[s['name'] for s in sheets]==expected_sheets})
    for sheet in sheets:
        checks.append({'name':sheet['name']+'.hidden','passed':sheet['hidden']==(1 if sheet['name']=='隐藏数据' else 0)})
    sheet=next(s for s in sheets if s['name']=='明细')
    edited=run['branch']=='edited'
    for row,col,value in [(2,0,'香蕉（SDK编辑）' if edited else '苹果'),(2,1,15 if edited else 10),
                           (4,1,40 if edited else 30),(6,1,30 if edited else 20)]:
        cell=sheet['cellData'][str(row)][str(col)]
        actual=float(cell['v']) if cell.get('t')==2 else cell.get('v')
        checks.append({'name':f'明细[{row},{col}].value','expected':value,'actual':actual,'passed':value==actual})
    for row,col,value in [(4,1,'=SUM(B3:B4)+5' if edited else '=SUM(B3:B4)'),(6,1,'=B3*2')]:
        actual=sheet['cellData'][str(row)][str(col)].get('f')
        checks.append({'name':f'明细[{row},{col}].formula','expected':value,'actual':actual,'passed':value==actual})
    notes=next(s for s in sheets if s['name']=='说明')
    expected=40 if edited else 30
    actual=float(notes['cellData']['2']['1']['v'])
    checks.append({'name':'说明!B3.cache','expected':expected,'actual':actual,'passed':expected==actual})
    reports.append({'kind':run['kind'],'family':run['family'],'branch':run['branch'],
                    'status':'passed' if all(c['passed'] for c in checks) else 'failed','checks':checks})
report={'runs':reports,'ms':(time.perf_counter()-start)*1000}
(ROOT/'reimport-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
for r in reports: print(json.dumps({k:r[k] for k in ['kind','family','branch','status']},ensure_ascii=False))
