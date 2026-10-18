import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import {MarkdownEditor} from '../../src/components/markdown/MarkdownEditor';
import '../../src/styles/app.css';
function Preview(){
  const query=new URLSearchParams(location.search),nativePrint=query.has('native-print'),diagrams=query.has('diagrams');
  const [value,setValue]=useState('# 编辑验收\r\n\r\n选择这段文字，并修改内容。\r\n\r\n## 计划\r\n\r\n- [ ] 待办\r\n\r\n| 项目 | 状态 |\r\n| --- | --- |\r\n| Markdown | 开发中 |\r\n'+(nativePrint?'\r\n$x^2$\r\n':''));
  const [documentKey,setDocumentKey]=useState<string|number>(0),[readOnly,setReadOnly]=useState(diagrams);
  // Harness-only external baseline updates exercise the public React props.
  useEffect(()=>{
    if(!diagrams)return;
    const load=(event:Event)=>{const fixture=(event as CustomEvent<{value:string;documentKey:string|number;readOnly?:boolean}>).detail;setValue(fixture.value);setDocumentKey(fixture.documentKey);setReadOnly(fixture.readOnly??true);};
    window.addEventListener('markdown-fixture-load',load);return()=>window.removeEventListener('markdown-fixture-load',load);
  },[diagrams]);
  return <MarkdownEditor value={value} documentKey={documentKey} readOnly={readOnly} onChange={next=>{setValue(next);window.dispatchEvent(new CustomEvent('markdown-fixture-change',{detail:next}));}} initialView={{mode:diagrams?'source':'split'}}
    onPrint={nativePrint?async document=>{window.dispatchEvent(new CustomEvent('markdown-print-prepared',{detail:document}));}:undefined}/>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
