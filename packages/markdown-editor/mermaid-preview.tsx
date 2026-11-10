// Isolated browser acceptance fixture. No native app or user workspace is opened.
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import mermaid from 'mermaid';
import { MarkdownEditor } from '../../src/components/markdown/MarkdownEditor';
import { buildRichEditorExtensions } from '../../src/components/rich-editor/extensions';
import { renderSafeDiagram } from './src/adapters/diagramPreviewSafety';
import { mermaidConfig } from './src/adapters/mermaidRenderer';
import { flowchart, sequence, gantt, fenced } from './tests/fixtures/mermaid';
import '../../src/styles/app.css';

function RecordFixture() {
  const editor = useEditor({ extensions: buildRichEditorExtensions('记录图表'), content: {
    type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'mermaid', languageExplicit: true }, content: [{ type: 'text', text: flowchart }] }, { type: 'paragraph' }],
  } });
  return <section><h2>Record</h2><button onClick={() => { if (editor) { const html = editor.getHTML(); editor.commands.setContent(html); } }}>保存并重开 Record</button><div className="rich-editor__content"><EditorContent editor={editor} /></div></section>;
}
function Fixture() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [comparison, setComparison] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [value, setValue] = useState([flowchart, sequence, gantt].map(fenced).join('\n\n'));
  const [printed, setPrinted] = useState('');
  useEffect(() => {
    void (async () => {
      // Compare the old default and GitHub-like accent candidate against the
      // selected warm neutral theme, with the same engine and fixture geometry.
      mermaid.initialize({ ...mermaidConfig('light'), theme: 'default', themeVariables: {} });
      const original = await mermaid.render('compare-original', flowchart);
      const config = mermaidConfig('light');
      mermaid.initialize({ ...config, themeVariables: { ...config.themeVariables, primaryColor: '#edf5ff', primaryBorderColor: '#0969da', primaryTextColor: '#1f2328', lineColor: '#0969da' } });
      const github = await mermaid.render('compare-github', flowchart);
      const selected = await renderSafeDiagram('mermaid', flowchart, 'light');
      setComparison([original.svg, github.svg, selected.ok ? selected.svg : selected.error]);
      setReady(true);
    })();
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return <main style={{ padding: 28, background: theme === 'dark' ? '#202124' : '#fbfbfa', color: theme === 'dark' ? '#eeece6' : '#37352f', minHeight: '100vh' }}>
    <h1>Mermaid · 记录与材料</h1>
    <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>切换为{theme === 'light' ? '深色' : '浅色'}</button>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 24, marginBlock: 24, background: '#fbfbfa', color: '#37352f', padding: 16 }}>
      {comparison.map((svg, index) => <section key={index}><h2>{['原默认', 'GitHub 蓝色候选', '采用：暖中性'][index]}</h2><div className="comparison" dangerouslySetInnerHTML={{ __html: svg }} /></section>)}
    </div>
    {ready && <div data-ready="true" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 28 }}>
      <RecordFixture />
      <section><h2>Markdown</h2><div style={{ height: 1100 }}><MarkdownEditor value={value} onChange={setValue} documentKey="acceptance" initialView={{ mode: 'preview' }} onPrint={async document => { setPrinted(document.html); }} /></div></section>
    </div>}
    <output data-print-html={printed} />
    <style>{`.comparison svg{max-width:100%;height:auto}h1{font-size:24px}h2{font-size:17px;margin:16px 0}button{padding:6px 12px;border:1px solid #98958c;border-radius:4px;cursor:pointer}pre{white-space:pre-wrap}.mind-markdown{color:#37352f}`}</style>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
