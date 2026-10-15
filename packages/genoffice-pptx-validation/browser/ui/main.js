// F03 probe: upstream GenOffice RenderTree, thin SVG adapter for the simple fixture.
// This is not GenOffice's complete desktop UI or Project Mind's File commit path.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
const h = React.createElement;
const plain = el => el.text?.paragraphs.map(p => p.runs.map(r => r.text).join('')).join('\n') || '';
const events = [];
window.pptValidation = { events };
function node(n) {
  const b = n.box;
  const children = [];
  if (n.type === 'picture') children.push(h('image', {key:'image',href:n.dataUrl,width:b.w,height:b.h}));
  else if (n.type === 'text' || n.type === 'shape') {
    if (n.fill?.kind === 'solid') children.push(h('rect',{key:'fill',width:b.w,height:b.h,fill:n.fill.color}));
    for (const [i,line] of (n.text?.lines || []).entries()) for (const [j,r] of line.runs.entries()) {
      children.push(h('text',{key:`${i}-${j}`,x:(n.text.insets.l || 0)+r.x,y:(n.text.insets.t || 0)+r.baselineY,fill:r.color,fontFamily:r.fontFamily,fontSize:r.fontSizePx,fontWeight:r.bold?'bold':undefined,fontStyle:r.italic?'italic':undefined},r.text));
    }
  } else throw new Error(`Simple fixture adapter does not implement ${n.type}`);
  return h('g',{key:n.id,transform:`translate(${b.x},${b.y}) rotate(${b.rotationDeg || 0},${b.w/2},${b.h/2})`},...children);
}
function App() {
  const [data,setData]=useState(null),[page,setPage]=useState(0),[id,setId]=useState(''),[text,setText]=useState(''),[status,setStatus]=useState('加载中');
  useEffect(()=>{fetch('/simple.noop.json').then(r=>{if(!r.ok)throw new Error(`Load ${r.status}`);return r.json();}).then(d=>{setData(d);setStatus('请选择文字块进行编辑');events.push({phase:'loaded',pages:d.renderSlides.length});}).catch(e=>setStatus(e.message));},[]);
  if(!data)return h('div',{id:'status'},status);
  const slide=data.renderSlides[page];
  const editable=data.deck.slides[page].elements.filter(e=>e.text);
  async function save() {
    try {
      const response=await fetch('/probe/edit-export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'simple',slideIndex:page,elementId:id,text})});
      const result=await response.json();if(!response.ok)throw new Error(result.error || `Export ${response.status}`);
      setData(result);setId('');setText('');setStatus(`已导出候选 PPTX：${result.bytes} bytes`);
      events.push({phase:'exported',sha256:result.hash,bytes:result.bytes,pages:result.renderSlides.length});
    }catch(e){setStatus(e.message);events.push({phase:'error',message:e.message});}
  }
  return h('main',null,h('aside',null,h('h2',null,'幻灯片'),...data.renderSlides.map((s,i)=>h('button',{key:i,'aria-pressed':page===i,onClick:()=>{setPage(i);setId('');setText('');}},`第 ${i+1} 页`)),h('h2',null,'文字内容'),...editable.map(e=>h('button',{key:e.id,'aria-pressed':id===e.id,onClick:()=>{setId(e.id);setText(plain(e));}},plain(e)))),h('section',null,h('div',{className:'page'},h('svg',{viewBox:`0 0 ${slide.widthPx} ${slide.heightPx}`,role:'img','aria-label':'幻灯片预览'},h('rect',{width:slide.widthPx,height:slide.heightPx,fill:slide.background?.color || 'white'}),...slide.nodes.map(node))),h('div',{className:'edit'},h('textarea',{'aria-label':'文字内容',value:text,disabled:!id,onChange:e=>setText(e.target.value)}),h('button',{disabled:!id,onClick:save},'保存候选 PPTX')),h('div',{id:'status'},status)));
}
createRoot(document.getElementById('root')).render(h(App));
