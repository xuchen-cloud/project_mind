import { useEffect, useState, type ReactNode } from 'react';
import type { DiagramLanguage, DiagramResult } from '../genoffice/editor/diagrams';
import { renderSafeDiagram } from './diagramPreviewSafety';

export function PreviewDiagram({ language, source, fallback }: { language: DiagramLanguage; source: string; fallback: ReactNode }) {
  const [result, setResult] = useState<{ source: string; language: DiagramLanguage; result: DiagramResult }>();
  useEffect(() => {
    let active = true;
    void renderSafeDiagram(language, source)
      .then(result => { if (active) setResult({ source, language, result }); });
    return () => { active = false; };
  }, [source, language]);
  // Hide the previous SVG synchronously, before this render's effect runs.
  const current = result?.source === source && result.language === language ? result.result : undefined;
  const name = language === 'mermaid' ? 'Mermaid' : 'WaveDrom';
  return <div className="mind-markdown__diagram" data-diagram-language={language}>
    {current?.ok ? <div role="img" aria-label={`${name} 图表`} className="mind-markdown__diagram-svg" dangerouslySetInnerHTML={{ __html: current.svg }} /> : <>
      <p className={current ? 'md-diagram-error' : 'mind-markdown__diagram-status'} role={current ? 'alert' : 'status'}>{current ? `${name}：${current.error}` : `正在渲染 ${name}…`}</p>
      {fallback}
    </>}
  </div>;
}
