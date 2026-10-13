"""External Office reopen only. All copies/profiles/PDFs/evidence live beside this script."""
import hashlib, json, re, shutil, subprocess, sys, time, os
from datetime import datetime, timezone
from pathlib import Path
import pypdf

ROOT=Path(__file__).resolve().parent
SHARED=ROOT.parent
SOFFICE=Path(os.environ.get('OFFICE_VALIDATION_SOFFICE') or shutil.which('soffice') or 'soffice')
RESULTS=ROOT/'results.json'
def sha(b):return hashlib.sha256(b).hexdigest()
def now():return datetime.now(timezone.utc).isoformat()
def write(): RESULTS.write_text(json.dumps(report,ensure_ascii=False,indent=2))
def command_run(command,timeout):
    started=time.perf_counter()
    try:
        p=subprocess.run(command,capture_output=True,text=True,timeout=timeout)
        return {'returncode':p.returncode,'elapsed_ms':(time.perf_counter()-started)*1000,'stdout':p.stdout,'stderr':p.stderr,'timeout':False}
    except subprocess.TimeoutExpired as e:
        def string(x):return x.decode(errors='replace') if isinstance(x,bytes) else x or ''
        return {'returncode':None,'elapsed_ms':(time.perf_counter()-started)*1000,'stdout':string(e.stdout),'stderr':string(e.stderr),'timeout':True}

if RESULTS.exists():
    report=json.loads(RESULTS.read_text())
else:
    report={'issue':'#118/F03','started':now(),'runtime':{'python':sys.version.split()[0],'pypdf':pypdf.__version__,'soffice':str(SOFFICE)},'cases':[],
      'scope':'18 existing SDK files; current/late browser chromium/webkit outputs. Conversion to PDF is external reopen evidence, not fidelity proof.'}
    report['runtime']['soffice_version']=command_run([str(SOFFICE),'--headless','--version'],60)

def jobs():
    values=[]
    for fmt in ['docx','xlsx','pptx']:
        for sample in ['simple','complex']:
            for branch in ['original','product-noop','product-edited']:
                suffix={'docx':{'original':'original','product-noop':'traditional.unit-noop','product-edited':'traditional.unit-edited'},
                  'xlsx':{'original':'original','product-noop':'unit.noop','product-edited':'unit.edited'},
                  'pptx':{'original':'original','product-noop':'product-unchanged','product-edited':'edited'}}[fmt][branch]
                values.append({'format':fmt,'sample':sample,'branch':branch,'source':str(SHARED/fmt/(sample+'.'+suffix+'.'+fmt)),'group':'sdk'})
    for engine in ['chromium','webkit']:
        base=SHARED/'browser/output'/engine
        if base.exists():
            for f in sorted(base.rglob('*')):
                if f.is_file() and f.suffix.lower() in ['.docx','.xlsx','.pptx']:
                    values.append({'format':f.suffix[1:],'sample':'simple','branch':'browser-edited','engine':engine,'source':str(f),'group':'browser'})
    return values

def convert(job):
    source=Path(job['source'])
    if not source.exists():
        return {**job,'status':'missing','error':'Input file absent; no conversion attempted'}
    data=source.read_bytes();digest=sha(data)
    for old in report['cases']:
        if old.get('source')==str(source) and old.get('source_sha256_before')==digest and old.get('status')=='reopened' and Path(old.get('pdf','')).exists():
            return None  # Reuse unchanged successful external reopen.
    identity=f"{job['group']}-{job.get('engine','')}-{job['format']}-{job['sample']}-{job['branch']}-{digest[:12]}"
    case_dir=ROOT/'cases'/identity
    case_dir.mkdir(parents=True,exist_ok=True)
    inputs=case_dir/'input';out=case_dir/'pdf';profile=case_dir/'profile'
    for directory in [inputs,out,profile]:directory.mkdir(exist_ok=True)
    local=inputs/source.name;local.write_bytes(data)
    c={**job,'id':identity,'started':now(),'source_bytes':len(data),'source_sha256_before':digest,'input_copy':str(local),'input_copy_sha256':sha(local.read_bytes()),'status':'failed'}
    command=[str(SOFFICE),'-env:UserInstallation='+profile.as_uri(),'--headless','--nologo','--nodefault','--nofirststartwizard','--norestore','--convert-to','pdf','--outdir',str(out),str(local)]
    c['command']=command;c['conversion']=command_run(command,60)
    c['source_sha256_after']=sha(source.read_bytes());c['source_unchanged']=c['source_sha256_after']==digest
    pdf=out/(local.stem+'.pdf');c['pdf']=str(pdf)
    if pdf.exists():
        try:
            reader=pypdf.PdfReader(pdf)
            pages=[]
            for i,page in enumerate(reader.pages):
                text=page.extract_text() or ''
                pages.append({'page':i+1,'text':text,'text_chars':len(text),'width_points':float(page.mediabox.width),'height_points':float(page.mediabox.height)})
            c['pdf_bytes']=pdf.stat().st_size;c['pdf_sha256']=sha(pdf.read_bytes());c['pdf_pages']=len(pages);c['pages']=pages
            c['text']='\n\f\n'.join(p['text'] for p in pages);c['extractable_text_chars']=sum(p['text_chars'] for p in pages)
            (case_dir/'text.txt').write_text(c['text'])
            if c['conversion']['returncode']==0 and not c['conversion']['timeout'] and c['source_unchanged'] and c['pdf_pages']>0:
                c['status']='reopened'
        except Exception as e:c['pdf_error']={'type':type(e).__name__,'message':str(e)}
    c['finished']=now()
    return c

def normalize(text):return re.sub(r'\s+','',text)
def compare():
    # Compare page-local text for noop; edits keep original text diffs visible for diagnosis.
    latest={c['source']:c for c in report['cases']}
    comparisons=[]
    for c in latest.values():
        if c['branch']=='original':continue
        original=latest.get(str(SHARED/c['format']/(c['sample']+'.original.'+c['format'])))
        if not original or original.get('status')!='reopened' or c.get('status')!='reopened':continue
        before=[normalize(p['text']) for p in original['pages']];after=[normalize(p['text']) for p in c['pages']]
        comparisons.append({'source':c['source'],'source_sha256':c['source_sha256_before'],'group':c['group'],'engine':c.get('engine'),'format':c['format'],'sample':c['sample'],'branch':c['branch'],
          'original_pages':original['pdf_pages'],'candidate_pages':c['pdf_pages'],'page_count_equal':original['pdf_pages']==c['pdf_pages'],
          'original_page_sizes':[[p['width_points'],p['height_points']] for p in original['pages']],
          'candidate_page_sizes':[[p['width_points'],p['height_points']] for p in c['pages']],
          'page_text_equal_ignoring_whitespace':before==after,'whole_text_equal_ignoring_whitespace':normalize(original['text'])==normalize(c['text']),
          'note':'Edited text is expected to differ; equal text/page count does not prove layout/image/formula fidelity.'})
    report['comparisons']=comparisons
    report['pending_browser_formats']={engine:[fmt for fmt in ['docx','xlsx','pptx'] if not any(c['group']=='browser' and c.get('engine')==engine and c['format']==fmt for c in latest.values())] for engine in ['chromium','webkit']}

for job in jobs():
    c=convert(job)
    if c is not None:
        report['cases'].append(c);write()
        print(json.dumps({k:c.get(k) for k in ['group','engine','format','sample','branch','status','pdf_pages','extractable_text_chars']},ensure_ascii=False),flush=True)
        print(json.dumps({'returncode':c.get('conversion',{}).get('returncode'),'elapsed_ms':c.get('conversion',{}).get('elapsed_ms'),'timeout':c.get('conversion',{}).get('timeout')},ensure_ascii=False),flush=True)
# Pick up browser files that arrived during the 18 baseline conversions; unchanged results are reused.
for job in [j for j in jobs() if j['group']=='browser']:
    c=convert(job)
    if c is not None:
        report['cases'].append(c);write();print(json.dumps({'late_browser':c['source'],'status':c['status'],'pdf_pages':c.get('pdf_pages')},ensure_ascii=False),flush=True)
compare();report['finished']=now();write()

rows=[]
for c in report['comparisons']:
    rows.append(f"| {c['engine'] or 'SDK'} | {c['format']} / {c['sample']} / {c['branch']} | {c['original_pages']} | {c['candidate_pages']} | {c['whole_text_equal_ignoring_whitespace']} |")
failed=[{k:c.get(k) for k in ['source','status','conversion','pdf_error']} for c in report['cases'] if c['status']!='reopened']
changed=[c for c in report['cases'] if c.get('source_unchanged') is False]
notes=f'''# Office 外部无窗口重开验证

关联 #118 / F03。仅创建 scratch/external/ 内的脚本、输入副本、独立 profile、独立 PDF 输出和证据；没有重跑 SDK。使用 bundled soffice --headless，逐文件 subprocess timeout=60s。LibreOffice 打开 SHA256 一致的 scratch 输入副本，来源文件只读并检查转换前后 hash。

## 结果边界

记录 {{}} 件输入版本，其中可重开 {{}} 件。**reopened 只代表返回值 0、PDF 可被 pypdf 读取并有页面，不代表保真通过。** 转换成功、相同页数和相同可抽取文字均不能证明图片、字体、表格位置、公式缓存或未支持对象保留。

原件/候选路径、原件与候选 SHA256、转换完整命令、返回值、stdout/stderr、耗时、PDF checksum、每页尺寸和可抽取文字见 results.json。每件独立目录里也有 text.txt。未对全部页面执行视觉验收。

DOCX 选显式 traditional 的 product unit 输出；XLSX 使用现有 forced 候选；PPTX 使用现有 product-unchanged/edited。原样本与候选均未覆盖，来源 hash 变化件数：{{}}。

| 来源 | 文件/链 | 原件 PDF 页数 | 候选 PDF 页数 | 全文相同（忽略空白） |
| --- | --- | --- | --- | --- |
{chr(10).join(rows)}

编辑候选文字应变化，表中 False 本身不判丢内容。页数变化是实际外部重开观测，需结合逐页文字/渲染定位。浏览器输出按 chromium/webkit 子目录读取；未就绪项记录在 results.json 的 pending_browser_formats。

## 失败与待解锁

{json.dumps(failed,ensure_ascii=False,indent=2)}

浏览器尚缺：{json.dumps(report['pending_browser_formats'],ensure_ascii=False)}。后续文件落盘后重跑脚本；来源 checksum 和现有 PDF 未变时复用已经完成的转换，不重跑 SDK。

## 可跑命令

```sh
python3 external/reopen.py
```

工具版本：{json.dumps(report['runtime'],ensure_ascii=False)}。
'''
notes=notes.replace('记录 {} 件输入版本，其中可重开 {} 件。',f"记录 {len(report['cases'])} 件输入版本，其中可重开 {sum(c['status']=='reopened' for c in report['cases'])} 件。").replace('来源 hash 变化件数：{}。',f'来源 hash 变化件数：{len(changed)}。')
(ROOT/'findings.md').write_text(notes)
print(json.dumps({'cases':len(report['cases']),'failed':len(failed),'source_changed':len(changed),'pending_browser':report['pending_browser_formats']},ensure_ascii=False),flush=True)
