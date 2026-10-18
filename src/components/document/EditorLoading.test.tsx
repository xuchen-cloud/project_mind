import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { EditorLoading, editorLoadingFormat } from './EditorLoading';

it('exposes one polite status with the actual stage and hides decorative skeletons from accessibility',()=>{
 const view=render(<EditorLoading format="docx" stage="resolve"/>);
 const status=screen.getByRole('status',{name:'文件加载状态'});
 expect(status).toHaveAttribute('aria-live','polite');expect(status).toHaveAttribute('aria-atomic','true');
 expect(status).toHaveTextContent('正在打开Word 文档');expect(status).toHaveTextContent('正在读取所选文件版本');
 expect(within(status).queryByRole('progressbar')).not.toBeInTheDocument();
 expect(status.querySelector('.editor-loading__canvas')).toHaveAttribute('aria-hidden','true');
 view.rerender(<EditorLoading format="docx" stage="render"/>);
 expect(screen.getAllByRole('status')).toHaveLength(1);expect(status).toHaveTextContent('正在准备文档画布');
 expect(status).not.toHaveTextContent('正在读取所选文件版本');
});
it.each([
 ['report.DOCX','docx','Word 文档'],['grid.xlsx','xlsx','Excel 工作簿'],['deck.pptx','pptx','PowerPoint 演示文稿'],['notes.markdown','markdown','Markdown 文档'],['README','document','文件'],
] as const)('uses %s as a format hint without exposing its filename as content', (fileName,format,label)=>{
 expect(editorLoadingFormat(fileName)).toBe(format);render(<EditorLoading fileName={fileName} stage="runtime"/>);
 expect(screen.getByRole('status')).toHaveTextContent(`正在打开${label}`);expect(screen.getByRole('status')).toHaveTextContent('正在加载编辑器');
 expect(screen.getByRole('status')).not.toHaveTextContent(fileName);
});
