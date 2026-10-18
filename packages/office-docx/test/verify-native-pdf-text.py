"""Explicit acceptance of actual native PDF output; never launches a native UI."""
import sys,json
from pathlib import Path
from pypdf import PdfReader
path=Path(sys.argv[1]);reader=PdfReader(path);text='\n'.join(page.extract_text() for page in reader.pages)
for expected in ['待修改中文段落：春风拂面。','姓名','状态','张三','第一页页脚：保留中文页脚','第三页保留']:
 assert expected in text, f'Native PDF copy/text extraction lost {expected!r}'
bold='未修改段落：山川日月保持原样。'
assert text.count(bold)==1, f'Native PDF synthetic bold repeated selectable text {text.count(bold)} times'
print(json.dumps({'pdf':str(path),'pages':len(reader.pages),'bodyTableHeaderFooterText':True,'boldTextExactlyOnce':True},ensure_ascii=False))
