import './EditorLoading.css';

export type EditorLoadingFormat = 'docx' | 'xlsx' | 'pptx' | 'markdown' | 'document';
export type EditorLoadingStage = 'resolve' | 'parse' | 'runtime' | 'render';

const formats = {
  docx: { label: 'Word 文档', shape: 'paper' },
  xlsx: { label: 'Excel 工作簿', shape: 'sheet' },
  pptx: { label: 'PowerPoint 演示文稿', shape: 'slide' },
  markdown: { label: 'Markdown 文档', shape: 'paper' },
  document: { label: '文件', shape: 'paper' },
} as const;
const stages: Record<EditorLoadingStage, string> = {
  resolve: '正在读取所选文件版本',
  parse: '正在解析文档内容',
  runtime: '正在加载编辑器',
  render: '正在准备文档画布',
};

/** A filename is a display hint only; readiness always comes from the owning renderer. */
export function editorLoadingFormat(fileName?: string): EditorLoadingFormat {
  const extension = fileName?.split('.').pop()?.toLowerCase();
  if (extension === 'docx' || extension === 'xlsx' || extension === 'pptx') return extension;
  return extension && ['md', 'mdown', 'markdown'].includes(extension) ? 'markdown' : 'document';
}

export function EditorLoading({ format, fileName, stage, overlay = false }: {
  format?: EditorLoadingFormat;
  fileName?: string;
  stage: EditorLoadingStage;
  overlay?: boolean;
}) {
  const { label, shape } = formats[format ?? editorLoadingFormat(fileName)];
  return <div className={`editor-loading${overlay ? ' editor-loading--overlay' : ''}`} role="status" aria-live="polite" aria-atomic="true" aria-label="文件加载状态" data-stage={stage}>
    <div className="editor-loading__content">
      <div className={`editor-loading__canvas editor-loading__canvas--${shape}`} aria-hidden="true">
        <div className="editor-loading__rail"><i /><i /><i /></div>
        <div className="editor-loading__page">
          <div className="editor-loading__heading" />
          <div className="editor-loading__lines">{Array.from({ length: 8 }, (_, index) => <span key={index} />)}</div>
          <div className="editor-loading__block" />
        </div>
      </div>
      <div className="editor-loading__status">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>
        <p>正在打开{label}</p>
      </div>
      <p className="editor-loading__stage">{stages[stage]}</p>
    </div>
  </div>;
}
