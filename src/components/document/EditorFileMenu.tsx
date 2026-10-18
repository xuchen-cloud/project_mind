import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Download, FileText, Printer} from 'lucide-react';
import {ActionContextMenu, type ContextMenuAction} from '../../ui/components/ActionContextMenu';
import type {EditorOutputCommand} from '../../lib/editor-output';

/** One host menu for all formats, also available in the read-only full renderer. */
export function EditorFileMenu({format, disabled, documentKey, onSelect}: {
  format: 'docx' | 'xlsx' | 'pptx' | 'markdown';
  disabled?: boolean;
  documentKey?: string | number;
  onSelect: (command: EditorOutputCommand) => void;
}) {
  const [anchor, setAnchor] = useState<{x:number;y:number} | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => setAnchor(null), [documentKey, disabled]);
  const output: [EditorOutputCommand, string][] = [['pdf', '导出 PDF']];
  if (format !== 'xlsx') output.push(['images', '导出图片']);
  if (format === 'docx') output.push(['html', '导出 HTML']);
  if (format === 'xlsx') output.push(['csv', '导出 CSV']);
  if (format === 'markdown') output.push(['docx', '导出 Word'], ['docs', '转换为 Word（下载）']);
  const actions: ContextMenuAction[] = output.map(([command, label]) => ({
    key: command, label, icon: Download, onSelect: () => onSelect(command),
  }));
  actions.push({type:'separator', key:'print-section'});
  if (format === 'docx') actions.push({key:'preview', label:'打印预览', icon:Printer, onSelect:() => onSelect('preview')});
  actions.push({key:'print', label:'打印…', icon:Printer, onSelect:() => onSelect('print')});
  function open() {
    const rect = trigger.current!.getBoundingClientRect();
    setAnchor({x:rect.left, y:rect.bottom + 4});
  }
  return <>
    <button ref={trigger} type="button" className="project-file-content__icon-button editor-file-menu__trigger" aria-label="文件菜单" title="文件菜单" aria-haspopup="menu" aria-expanded={!!anchor} disabled={disabled}
      onClick={() => anchor ? setAnchor(null) : open()} onKeyDown={event => {if (event.key === 'ArrowDown') {event.preventDefault();open();}}}>
      <FileText size={14} aria-hidden="true"/>
    </button>
    {anchor ? createPortal(<ActionContextMenu x={anchor.x} y={anchor.y} ariaLabel="文件" actions={actions} onClose={() => {setAnchor(null);trigger.current?.focus();}}/>, document.body) : null}
  </>;
}
