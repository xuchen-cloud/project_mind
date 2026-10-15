from pathlib import Path
from zipfile import ZipFile
from lxml import etree as ET
import json, hashlib, struct
from compare import compare
ROOT=Path(__file__).resolve().parent
def sha(b): return hashlib.sha256(b).hexdigest()
def properties(p):
    with ZipFile(p) as z:
        return {n:{key:ET.fromstring(z.read(n)).xpath(f'//*[local-name()="{key}"]/text()') for key in ['creator','Company','Application']} for n in ['docProps/core.xml','docProps/app.xml']}
def compressed_parts(p):
    data=p.read_bytes()
    with ZipFile(p) as z:
        out={}
        for i in z.infolist():
            pos=i.header_offset
            name_len,extra_len=struct.unpack_from('<HH',data,pos+26)
            start=pos+30+name_len+extra_len
            out[i.filename]=sha(data[start:start+i.compress_size])
        return out
def unaffected_xml(p):
    with ZipFile(p) as z:
        out={}
        for n in z.namelist():
            if n.startswith('xl/worksheets/sheet') and n.endswith('.xml'):
                t=ET.fromstring(z.read(n))
                ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
                # The only allowed content/cache changes are A3/B3/B5/B7 on sheet1 and B3 on sheet2.
                allowed=['A3','B3','B5','B7'] if n.endswith('sheet1.xml') else ['B3'] if n.endswith('sheet2.xml') else []
                for c in t.findall('.//s:c',ns):
                    if c.get('r') in allowed:
                        for child in list(c):
                            if ET.QName(child).localname in ['v','f','is']: c.remove(child)
                        c.attrib.pop('t',None)
                # Mutation updates calculated dimensions but should not change noncell features.
                out[n]=ET.tostring(t,method='c14n').decode()
        return out
def verify_candidate(kind, dest, edited=True, mutation=None, sdk=None):
    src=ROOT/f'{kind}.original.xlsx'; dest=Path(dest)
    run=compare(src,dest,edited)
    a,b=properties(src),properties(dest)
    run['checks'].append({'name':'creator_company_application','passed':a==b,'expected':a,'actual':b,'category':'metadata'})
    declared=set(mutation['touchedEntries']+mutation['removedEntries']+mutation['addedEntries']) if mutation is not None else ({'xl/worksheets/sheet1.xml','xl/worksheets/sheet2.xml'} if edited else set())
    a,b=compressed_parts(src),compressed_parts(dest)
    failures=[n for n in a if n not in declared and a[n]!=b.get(n)]
    run['checks'].append({'name':'untouched_compressed_payloads','passed':not failures,'expected':[],'actual':failures,'category':'preservation'})
    a,b=unaffected_xml(src),unaffected_xml(dest)
    changed=[n for n in a if a[n]!=b.get(n)]
    run['checks'].append({'name':'worksheet_xml_outside_allowed_edits','passed':not changed,'expected':[],'actual':changed,'category':'preservation'})
    run['checks'].append({'name':'no_extra_or_missing_zip_parts','passed':not run['zip_parts']['added'] and not run['zip_parts']['deleted'],'expected':{'added':[],'deleted':[]},'actual':{k:run['zip_parts'][k] for k in ['added','deleted']},'category':'preservation'})
    if sdk is not None:
        targets=[('明细',2,0,'value','香蕉（SDK编辑）' if edited else '苹果'),('明细',2,1,'value',15 if edited else 10),('明细',4,1,'formula','=SUM(B3:B4)+5' if edited else '=SUM(B3:B4)'),('明细',4,1,'value',40 if edited else 30),('明细',6,1,'value',30 if edited else 20),('说明',2,1,'value',40 if edited else 30)]
        for sheet,row,col,field,value in targets:
            sh=next(s for s in sdk['metadata']['sheets'] if s['name']==sheet)
            c=next(c for c in sdk['ranges'][sh['id']]['cells'] if c['row']==row and c['column']==col)
            actual=c.get(field)
            passed=str(actual).lstrip('=')==value.lstrip('=') if field=='formula' else actual==value
            run['checks'].append({'name':f'sdk.{sheet}.{row}:{col}.{field}','passed':passed,'expected':value,'actual':actual,'category':'sdk'})
    run['failures']=[c for c in run['checks'] if not c['passed']]
    run['assertions']=len(run['checks']);run['failed_assertions']=len(run['failures']);run['passed_assertions']=run['assertions']-run['failed_assertions']
    run['status']='failed' if run['failures'] else 'passed'
    return run

if __name__=='__main__':
    sdk=json.loads((ROOT/'sdk-results.json').read_text())
    report={'issue':'#118/F03','commit':sdk['commit'],'authoring':'upstream gateway mutation plan + Rust sidecar','validator':'openpyxl + lxml + ZIP compressed payload hashes','runs':[]}
    for r in sdk['runs']:
        run={k:r[k] for k in ['kind','branch','status']}
        if 'output' not in r:
            run.update(error=r.get('error'));report['runs'].append(run);continue
        run.update(verify_candidate(r['kind'],ROOT/r['output']['file'],r['branch']!='noop',r['mutation']))
        run['sdk_checks']=r.get('sdkChecks',[])
        run['sdk_formula_caches']=r.get('sdkFormulaCaches',[])
        if not all(c['passed'] for c in run['sdk_checks']+run['sdk_formula_caches']): run['status']='failed'
        report['runs'].append(run)
        print(json.dumps({'kind':run['kind'],'branch':run['branch'],'status':run['status'],'assertions':run['assertions'],'failures':[c['name'] for c in run['failures']]},ensure_ascii=False))
    manifest=json.loads((ROOT/'fixtures.json').read_text())
    report['original_checksums_unchanged']={k:sha((ROOT/f'{k}.original.xlsx').read_bytes())==s['sha256'] for k,s in manifest['samples'].items()}
    (ROOT/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2,default=str)+'\n')
