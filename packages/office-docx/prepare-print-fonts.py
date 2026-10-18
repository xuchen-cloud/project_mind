"""Rebuild print-only TrueType outlines from the immutable upstream CFF subsets.
Requires fonttools[woff]==4.60.1, brotli==1.1.0, zopfli==0.2.3.post1.
Normal builds verify checked-in derived assets; they do not need Python.
"""
from pathlib import Path
import hashlib,json
from importlib.metadata import version
for package,expected in [("fonttools","4.60.1"),("brotli","1.1.0"),("zopfli","0.2.3.post1")]:
 assert version(package)==expected, f"Rebuild requires {package}=={expected}"
from fontTools.ttLib import TTFont,newTable
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.pens.cu2quPen import Cu2QuPen
root=Path(__file__).resolve().parent
names=['NotoSerifCJKsc-Regular-subset.woff2','NotoSansCJKsc-Regular-subset.woff2','GenOfficeSansKR-Regular-subset.woff2','GenOfficeSerifKR-Regular-subset.woff2','GenOfficeCheLatinKR.woff2']
manifest={'upstreamCommit':'d32d1711f1bf985430757b8c6b3fbddd3831d946','fonttools':'4.60.1','brotli':'1.1.0','zopfli':'0.2.3.post1','maxCurveErrorEm':0.0005,'files':[]}
for index,name in enumerate(names):
 source=root/'upstream/apps/docs/src/renderer/fonts'/name
 original=TTFont(source,recalcTimestamp=False);f=TTFont(source,recalcTimestamp=False);gs=f.getGlyphSet();glyphs={}
 for glyphName in f.getGlyphOrder():
  pen=TTGlyphPen(gs);gs[glyphName].draw(Cu2QuPen(pen,max_err=f['head'].unitsPerEm*0.0005,reverse_direction=True));glyphs[glyphName]=pen.glyph()
 del f['CFF '];f.sfntVersion='\x00\x01\x00\x00';f['maxp']=newTable('maxp');f['maxp'].tableVersion=0x10000
 fb=FontBuilder(font=f);fb.isTTF=True;fb.setupGlyf(glyphs);fb.setupMaxp();f['post'].formatType=3.0
 for r in f['name'].names:
  if r.nameID in [1,3,4,6,16]:r.string=(f'PMWordPrint{index}' if r.nameID==6 else f'Project Mind Word Print {index}').encode(r.getEncoding())
 f.flavor='woff2';target=root/'print-fonts'/name;f.save(target)
 reopened=TTFont(target)
 # post v3 removes names, not character-to-glyph identity or advance metrics.
 assert {cp:reopened.getGlyphID(name) for cp,name in reopened.getBestCmap().items()}=={cp:original.getGlyphID(name) for cp,name in original.getBestCmap().items()}
 for tag in ['hmtx','vmtx']:
  if tag in original:assert [reopened[tag].metrics[n] for n in reopened.getGlyphOrder()]==[original[tag].metrics[n] for n in original.getGlyphOrder()]
 assert reopened['head'].unitsPerEm==original['head'].unitsPerEm
 entry={'source':'apps/docs/src/renderer/fonts/'+name,'sourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'file':name,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size,'glyphs':len(glyphs)}
 manifest['files'].append(entry);print(name,entry['bytes'],entry['glyphs'])
(root/'print-fonts/source-lock.json').write_text(json.dumps(manifest,indent=2)+'\n')
(root/'print-fonts/LICENSE-OFL.txt').write_bytes((root/'upstream/apps/docs/src/renderer/fonts/LICENSE-OFL.txt').read_bytes())
