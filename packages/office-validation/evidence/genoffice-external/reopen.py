"""GenOffice external PDF evidence. No SDK, GUI, PNG, or node_modules required."""
import argparse,difflib,hashlib,json,re,shutil,subprocess,sys,time
from datetime import datetime,timezone
from pathlib import Path
import pypdf

parser=argparse.ArgumentParser()
parser.add_argument('--scratch',type=Path,default=Path('/tmp/project-mind-genoffice-pptx-validation-20261013'))
parser.add_argument('--univer-evidence',type=Path,default=Path('/tmp/project-mind-univer-validation-20261013/scratch/external/results.json'))
args=parser.parse_args()
SOURCE=args.scratch.resolve();ROOT=SOURCE/'external';ROOT.mkdir(exist_ok=True)
SOFFICE=Path('/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice')
POPPLER=Path('/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdftotext')
def sha(data):return hashlib.sha256(data).hexdigest()
def now():return datetime.now(timezone.utc).isoformat()
def run(command):
    start=time.perf_counter()
    try:
        p=subprocess.run(command,capture_output=True,text=True,timeout=60)
        return {'command':command,'returncode':p.returncode,'elapsed_ms':(time.perf_counter()-start)*1000,'stdout':p.stdout,'stderr':p.stderr,'timeout':False}
    except subprocess.TimeoutExpired as e:
        def text(x):return x.decode(errors='replace') if isinstance(x,bytes) else x or ''
        return {'command':command,'returncode':None,'elapsed_ms':(time.perf_counter()-start)*1000,'stdout':text(e.stdout),'stderr':text(e.stderr),'timeout':True}
def save(): (ROOT/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
def normalize(text):return re.sub(r'\s+','',text)

reuse=json.loads(args.univer_evidence.read_text()) if args.univer_evidence.exists() else {'cases':[]}
old=json.loads((ROOT/'results.json').read_text()) if (ROOT/'results.json').exists() else {'cases':[]}
report={'issue':'#118/F03','candidate':'GenOffice PPTX','started':now(),'runtime':{'python':sys.version.split()[0],'pypdf':pypdf.__version__,'soffice':str(SOFFICE),'pdftotext':str(POPPLER)},'cases':[],
 'scope':'External reopen only; source files remain read-only; no SDK re-run, GUI, extra PNG or browser watermark check.',
 'visual_limit':'Earlier exact-hash original PDFs show missing/box Chinese in the bundled headless renderer; Poppler extraction succeeds. No new PNG produced; Chinese visual fidelity remains unverified.'}
for sample in ['simple','complex']:
    for branch in ['original','noop','edited']:
        report['cases'].append({'sample':sample,'branch':branch,'source':str(SOURCE/(sample+'.'+branch+'.pptx'))})
for engine in ['chromium','webkit']:
    report['cases'].append({'sample':'simple','branch':'browser-edited','engine':engine,'source':str(SOURCE/'browser/output'/engine/'simple.browser-edited.pptx')})

for index,job in enumerate(report['cases']):
    source=Path(job['source'])
    if not source.exists():
        job.update(status='missing',error='Source absent; browser output must be saved before external reopen');save();continue
    data=source.read_bytes();digest=sha(data)
    previous=next((c for c in old['cases'] if c['source']==str(source) and c.get('source_sha256')==digest and c.get('status')=='reopened' and Path(c.get('pdf','')).exists()),None)
    if previous:
        report['cases'][index]=previous;continue
    identity=job['sample']+'-'+job.get('engine',job['branch'])+'-'+digest[:12]
    case=ROOT/'cases'/identity;pdfdir=case/'pdf';profile=case/'profile';inputs=case/'input'
    for directory in [case,pdfdir,profile,inputs]:directory.mkdir(parents=True,exist_ok=True)
    local=inputs/source.name;local.write_bytes(data);pdf=pdfdir/(source.stem+'.pdf')
    job.update(source_sha256=digest,source_bytes=len(data),started=now(),input_copy=str(local),pdf=str(pdf),status='failed')
    matching=next((c for c in reuse['cases'] if job['branch']=='original' and c.get('format')=='pptx' and c.get('branch')=='original' and c.get('source_sha256_before')==digest and c.get('status')=='reopened'),None)
    if matching and Path(matching['pdf']).exists() and sha(Path(matching['pdf']).read_bytes())==matching['pdf_sha256']:
        shutil.copyfile(matching['pdf'],pdf)
        job['conversion']={'method':'reused-exact-input-hash','returncode':0,'elapsed_ms':0,'original_conversion':matching['conversion']}
        job['reuse']={'evidence':str(args.univer_evidence.resolve()),'record_id':matching.get('id'),'original_input_sha256':digest,'source_pdf':matching['pdf'],'source_pdf_sha256':matching['pdf_sha256'],'prior_text_diagnostic':str(args.univer_evidence.parent/'text-diagnostic.json')}
    else:
        job['conversion']=run([str(SOFFICE),'-env:UserInstallation='+profile.as_uri(),'--headless','--nologo','--nodefault','--nofirststartwizard','--norestore','--convert-to','pdf','--outdir',str(pdfdir),str(local)])
        job['conversion']['method']='actual-headless-conversion'
    job['source_sha256_after']=sha(source.read_bytes());job['source_unchanged']=job['source_sha256_after']==digest
    if pdf.exists():
        try:
            reader=pypdf.PdfReader(pdf);textfile=case/'text-poppler.txt'
            job['text_extraction']=run([str(POPPLER),'-enc','UTF-8',str(pdf),str(textfile)])
            text=textfile.read_text() if textfile.exists() else ''
            chunks=text.split('\f')
            if chunks and not chunks[-1].strip():chunks.pop()
            pages=[]
            for n,page in enumerate(reader.pages):
                images=[]
                for image in page.images:
                    im=image.image
                    images.append({'name':image.name,'width_pixels':im.width,'height_pixels':im.height,'rgba_pixels_sha256':sha(im.convert('RGBA').tobytes())})
                draw_names=[str(operands[0]) for operands,operator in page.get_contents().operations if operator==b'Do']
                image_resources=page['/Resources'].get('/XObject',{})
                drawn_images=[name for name in draw_names if image_resources[name].get_object().get('/Subtype')=='/Image']
                pages.append({'page':n+1,'width_points':float(page.mediabox.width),'height_points':float(page.mediabox.height),'text':chunks[n].strip() if len(chunks)==len(reader.pages) else None,'images':images,'image_resource_count':len(images),'image_count':len(drawn_images),'drawn_image_resources':drawn_images})
            job.update(pdf_pages=len(pages),pdf_bytes=pdf.stat().st_size,pdf_sha256=sha(pdf.read_bytes()),pages=pages,text=text,text_file=str(textfile),chart_title_business_quantity_present='业务数量' in text)
            if job['conversion']['returncode']==0 and job['source_unchanged'] and job['pdf_pages']>0 and job['text_extraction']['returncode']==0 and len(chunks)==len(reader.pages):job['status']='reopened'
        except Exception as e:job['pdf_error']={'type':type(e).__name__,'message':str(e)}
    job['finished']=now();save()
    print(json.dumps({k:job.get(k) for k in ['sample','branch','engine','status','pdf_pages','chart_title_business_quantity_present']},ensure_ascii=False),flush=True)

comparisons=[]
for candidate in report['cases']:
    if candidate['branch']=='original':continue
    original=next(c for c in report['cases'] if c['sample']==candidate['sample'] and c['branch']=='original')
    if original.get('status')!='reopened' or candidate.get('status')!='reopened':continue
    before=[normalize(p['text']) for p in original['pages']];after=[normalize(p['text']) for p in candidate['pages']]
    diffs=[]
    for p,q in zip(original['pages'],candidate['pages']):
        diff='\n'.join(difflib.unified_diff(p['text'].splitlines(),q['text'].splitlines(),fromfile='original-page-'+str(p['page']),tofile=candidate['branch']+'-page-'+str(q['page']),lineterm=''))
        if diff:diffs.append({'page':p['page'],'diff':diff})
    image_signature=lambda c:[[{'width_pixels':i['width_pixels'],'height_pixels':i['height_pixels'],'rgba_pixels_sha256':i['rgba_pixels_sha256']} for i in p['images']] for p in c['pages']]
    comparisons.append({'sample':candidate['sample'],'branch':candidate['branch'],'engine':candidate.get('engine'),'source':candidate['source'],'source_sha256':candidate['source_sha256'],
      'original_pages':original['pdf_pages'],'candidate_pages':candidate['pdf_pages'],'page_count_equal':original['pdf_pages']==candidate['pdf_pages'],
      'page_sizes_equal':[(p['width_points'],p['height_points']) for p in original['pages']]==[(p['width_points'],p['height_points']) for p in candidate['pages']],
      'page_text_equal_ignoring_whitespace':before==after,'whole_text_equal_ignoring_whitespace':normalize(original['text'])==normalize(candidate['text']),
      'original_image_counts':[p['image_count'] for p in original['pages']],'candidate_image_counts':[p['image_count'] for p in candidate['pages']],
      'embedded_image_pixels_equal':image_signature(original)==image_signature(candidate),
      'original_chart_title_present':original['chart_title_business_quantity_present'],'candidate_chart_title_present':candidate['chart_title_business_quantity_present'],'page_text_diffs':diffs})
report['comparisons']=comparisons;report['finished']=now()
report['summary']={'cases':len(report['cases']),'reopened':sum(c.get('status')=='reopened' for c in report['cases']),
 'actual_headless_conversions':sum(c.get('conversion',{}).get('method')=='actual-headless-conversion' for c in report['cases']),
 'reused_original_conversions':sum(c.get('conversion',{}).get('method')=='reused-exact-input-hash' for c in report['cases']),
 'source_unchanged':all(c.get('source_unchanged') for c in report['cases']),
 'all_page_counts_equal':all(c['page_count_equal'] for c in comparisons)}
save()
rows=[]
for c in report['cases']:
    rows.append(f"| {c['sample']} / {c.get('engine',c['branch'])} | {c.get('pdf_pages')} | {[p['image_count'] for p in c.get('pages',[])]} | {c.get('chart_title_business_quantity_present')} | {c.get('conversion',{}).get('method')} |")
issues=[c for c in report['cases'] if c.get('status')!='reopened']
noops=[c for c in comparisons if c['branch']=='noop']
notes=f'''# GenOffice PPTX 外部重开结果

关联 #118 / F03。执行 agent 验证；不是 review，不检查浏览器水印。

## 结果与边界

{json.dumps(report['summary'],ensure_ascii=False)}

只在 `{ROOT}` 创建文件；没有修改源 PPTX 或重跑 SDK，没有 GUI、没有新增 PNG。每个候选使用 SHA256 一致的 scratch 输入副本、独立 LibreOffice profile/PDF 输出目录，subprocess timeout=60s。两个原件的输入 SHA256 与先前 Univer 原件记录相同，并且复用 PDF 的 checksum 也核对一致，已复制到本目录并记录 `reuse` 完整来源。候选新 hash 全部实际转换。

**reopened 表示原格式可被独立 LibreOffice 打开并产生 pypdf 可读 PDF，不能直接称保真通过。** Poppler 可抽取中文不证明中文视觉正确；与原件图像像素相同不证明位置相同。当前 headless 中文方框/不可见限制沿用同 hash 原件证据，如实保留；本轮按指示没有更多 PNG。

| 样本/链 | PDF 页数 | 各页图片数 | 业务数量标题 | 转换方式 |
| --- | --- | --- | --- | --- |
{chr(10).join(rows)}

## 内容比较

无改链全文相同（忽略空白）：{json.dumps({c['sample']:c['whole_text_equal_ignoring_whitespace'] for c in noops},ensure_ascii=False)}。

原件与所有候选的页数、页面尺寸、逐页 Poppler 文本/文字 diff、图片数/尺寸/像素 hash、图表标题 `业务数量` 判断见 results.json。simple 原件没有图表，标题 False 在该样本是“不适用”，不能记成丢失。complex 原件及其候选分别判断；若候选 False，仍记录失败证据，不省略断言。

编辑候选文字本来应不同；本轮只记录外部差异，不将全文相等作为编辑成功条件。图片位置和水印由主 agent 的浏览器验收负责，不重复该任务。

## 失败

{json.dumps(issues,ensure_ascii=False)}

没有可重开失败时也不宣称完整 Office 保真；中文视觉、未支持对象和主应用集成仍需各自验收。

## 版本与复跑

使用同 bundled LibreOfficeDev 26.8.0.0.alpha0（前次原件记录附 version），Poppler 26.05.0，pypdf {pypdf.__version__}，Python {sys.version.split()[0]}。脚本不引用或安装 node_modules；仅用 Python/pypdf 和系统进程。原件/候选不可覆盖；已有同 source hash 的 successful 结果可复用。

```sh
/Users/xuchen/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 /tmp/project-mind-genoffice-pptx-validation-20261013/external/reopen.py
```

归档脚本也接受 `--scratch <GenOffice样本目录> --univer-evidence <已有原件结果JSON>`；全部输出仍限于该 scratch/external/。
'''
(ROOT/'findings.md').write_text(notes)
print(json.dumps(report['summary'],ensure_ascii=False),flush=True)
