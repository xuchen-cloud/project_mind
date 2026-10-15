from pathlib import Path
import json, hashlib, platform
from importlib.metadata import version
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.chart.data import ChartData
from pptx.enum.chart import XL_CHART_TYPE
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parent
if any((ROOT/f'{kind}.original.pptx').exists() for kind in ['simple','complex']):
    raise SystemExit('原件已存在，拒绝覆盖。复用 manifest.json 并直接执行验证脚本。')
OLD='项目进展正常'
NEW='项目进展更新'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def textbox(slide, text, x, y, w, h, size=22):
    shape=slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    shape.text=text
    for para in shape.text_frame.paragraphs:
        for run in para.runs:
            run.font.name='Microsoft YaHei'; run.font.size=Pt(size)
    return shape

im=Image.new('RGB',(320,180),'#167d8d')
d=ImageDraw.Draw(im)
d.rectangle((20,20,140,160),fill='#f7b534')
d.ellipse((175,40,295,160),fill='#eeeeee')
im.save(ROOT/'fixture.png')
manifest={'issue':118,'package':'F03','old_text':OLD,'new_text':NEW,'target_slide_index':0,'picture_delta_emu':914400//4,'versions':{'python':platform.python_version(),**{p:version(p) for p in ['python-pptx','Pillow','lxml']}},'samples':{}}
for kind in ['simple','complex']:
    prs=Presentation(); prs.slide_width=Inches(13.333); prs.slide_height=Inches(7.5)
    slides=[]
    for i,title in enumerate(['第一页：项目概况','第二页：数据保留','第三页：收尾记录']):
        s=prs.slides.add_slide(prs.slide_layouts[6 if kind=='simple' else [0,5,6][i]])
        for shape in list(s.shapes):
            if shape.is_placeholder and shape.has_text_frame: shape.text=''
        textbox(s,title,.6,.4,11,1,28)
        textbox(s,OLD if i==0 else ['','未编辑中文：第二页原文。','未编辑中文：第三页原文。'][i],.6,1.6,11,.6)
        textbox(s,f'固定页序标识：PAGE-{i+1}',.6,6.5,9,.4,16)
        if kind=='complex': s.notes_slide.notes_text_frame.text=f'演讲者备注第{i+1}页：此内容必须保留。'
        slides.append(s)
    pic=slides[0].shapes.add_picture(str(ROOT/'fixture.png'),Inches(.8),Inches(2.8),width=Inches(3.2))
    pic.name='validation-picture'
    textbox(slides[0],'未编辑图片说明：黄方块与白圆。',4.5,3.2,7,1)
    if kind=='complex':
        tab=slides[1].shapes.add_table(3,3,Inches(.8),Inches(2.5),Inches(7.2),Inches(2)).table
        for r,row in enumerate([['事项','数量','状态'],['中文资料','12','保留'],['图表验证','24','完成']]):
            for c,val in enumerate(row): tab.cell(r,c).text=val
        cd=ChartData(); cd.categories=['一月','二月','三月']; cd.add_series('业务数量',[12,24,18])
        slides[2].shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED,Inches(.8),Inches(2.4),Inches(8.8),Inches(3.7),cd)
    path=ROOT/f'{kind}.original.pptx'; prs.save(path)
    manifest['samples'][kind]={'path':path.name,'sha256':sha(path),'bytes':path.stat().st_size,'picture':{'slide_index':0,'shape_id':pic.shape_id,'name':pic.name,'left':pic.left,'top':pic.top,'width':pic.width,'height':pic.height,'sha256':sha(ROOT/'fixture.png')},'required_features':['text','image','slide_order','layout_master']+(['table','chart','notes'] if kind=='complex' else [])}
(ROOT/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
print(json.dumps(manifest,ensure_ascii=False))
