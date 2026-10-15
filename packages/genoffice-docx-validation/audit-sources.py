from pathlib import Path
import json,hashlib,re
ROOT=Path(__file__).resolve().parent
rows=[]
for file in ['source-provenance.json','extra-source-provenance.json']:rows+=json.loads((ROOT/file).read_text())['files']
by_path={r['path']:r for r in rows}
for r in rows:
 data=(ROOT/'upstream'/r['path']).read_bytes()
 assert hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==r['git_blob_sha1'],r['path']
meta=json.loads((ROOT/'build/prototype.browser.js.meta.json').read_text())
inputs=[p for p in meta['inputs'] if p.startswith('upstream/')]
assert all(p[len('upstream/'):] in by_path for p in inputs)
assert not any('/ee/' in p for p in inputs)
assert meta['outputs']['build/prototype.browser.js']['imports']==[]
focus=['packages/docx-engine/src/index.ts','packages/docx-engine/src/watermark.ts','packages/docx-engine/src/patch.ts','apps/docs/src/renderer/editor/extensions.ts','apps/docs/src/renderer/components/PaginationPreview.tsx','apps/docs/src/renderer/pagination.ts']
matches=[]
for p in focus:
 for i,line in enumerate((ROOT/'upstream'/p).read_text().splitlines(),1):
  if re.search(r'license|watermark|branding|trial|GenOffice|genspark|ee/',line,re.I):matches.append({'path':p,'line':i,'text':line.strip()})
out={'commit':'d32d1711f1bf985430757b8c6b3fbddd3831d946','verified_source_count':len(rows),'bundled_upstream_source_count':len(inputs),'remaining_browser_imports':[],'ee_in_bundle':False,'source_matches':matches,'conclusion':'公开 core 的 watermark 为 DOCX 内容/用户编辑功能；调查路径未发现强制品牌水印或运行时 license key。薄宿主实际交互由主 agent 验证，完整 PaginationPreview 尚未挂载。','license':'Apache-2.0; upstream LICENSE/NOTICE retained; third-party and font notices retained as fetched source, binary font assets not downloaded','preview_runtime_verified':False,'archive_strategy':'Recorded source audit reused; upstream sources and generated bundles are re-fetched/rebuilt from locked provenance and excluded from submission; LICENSE/NOTICE retained separately.'}
(ROOT/'public-core-audit.json').write_text(json.dumps(out,ensure_ascii=False,indent=2))
print('verified',len(rows),'sources;',len(inputs),'bundled upstream inputs; no external browser imports or ee')
