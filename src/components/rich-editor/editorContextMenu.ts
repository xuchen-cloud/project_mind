import type { Editor, ChainedCommands } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine, Bold, Code2, Columns2, Combine, Copy, File as FileIcon, Heading1, Heading2, Heading3, Heading4, Highlighter, Image, Italic, List, ListOrdered, ListTodo, Minus, MoreHorizontal, Paperclip, PanelLeft, PanelTop, Quote, Rows2, Scissors, Split, Strikethrough, Table2, Trash2, Type, type LucideIcon } from 'lucide-react';
import type { ContextMenuAction, ContextMenuInlineAction } from '../../ui/components/ActionContextMenu';

export interface EditorToolbarItem {
  key: string; label: string; icon: LucideIcon;
  isActive: () => boolean; isDisabled?: () => boolean; run: () => unknown;
}

export function buildTableToolbarGroups(editor: Editor, readOnly: boolean) {
  const editorDisabled = () => readOnly || editor.isDestroyed || !editor.isEditable;

  return [
    [
      {
        key: "add-row-before",
        label: "上方插入行",
        icon: ArrowUpToLine,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().addRowBefore(),
        run: () => !editorDisabled() && editor.chain().focus().addRowBefore().run(),
      },
      {
        key: "add-row-after",
        label: "下方插入行",
        icon: ArrowDownToLine,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().addRowAfter(),
        run: () => !editorDisabled() && editor.chain().focus().addRowAfter().run(),
      },
      {
        key: "add-column-before",
        label: "左侧插入列",
        icon: ArrowLeftToLine,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().addColumnBefore(),
        run: () => !editorDisabled() && editor.chain().focus().addColumnBefore().run(),
      },
      {
        key: "add-column-after",
        label: "右侧插入列",
        icon: ArrowRightToLine,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().addColumnAfter(),
        run: () => !editorDisabled() && editor.chain().focus().addColumnAfter().run(),
      },
    ],
    [
      {
        key: "merge-cells",
        label: "合并单元格",
        icon: Combine,
        isActive: () => editor.state.selection instanceof CellSelection,
        isDisabled: () => editorDisabled() || !editor.can().mergeCells(),
        run: () => !editorDisabled() && editor.chain().focus().mergeCells().run(),
      },
      {
        key: "split-cell",
        label: "拆分单元格",
        icon: Split,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().splitCell(),
        run: () => !editorDisabled() && editor.chain().focus().splitCell().run(),
      },
      {
        key: "toggle-header-row",
        label: "切换首行表头",
        icon: PanelTop,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().toggleHeaderRow(),
        run: () => !editorDisabled() && editor.chain().focus().toggleHeaderRow().run(),
      },
      {
        key: "toggle-header-column",
        label: "切换首列表头",
        icon: PanelLeft,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().toggleHeaderColumn(),
        run: () => !editorDisabled() && editor.chain().focus().toggleHeaderColumn().run(),
      },
    ],
    [
      {
        key: "delete-row",
        label: "删除当前行",
        icon: Rows2,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().deleteRow(),
        run: () => !editorDisabled() && editor.chain().focus().deleteRow().run(),
      },
      {
        key: "delete-column",
        label: "删除当前列",
        icon: Columns2,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().deleteColumn(),
        run: () => !editorDisabled() && editor.chain().focus().deleteColumn().run(),
      },
      {
        key: "delete-table",
        label: "删除表格",
        icon: Trash2,
        isActive: () => false,
        isDisabled: () => editorDisabled() || !editor.can().deleteTable(),
        run: () => !editorDisabled() && editor.chain().focus().deleteTable().run(),
      },
    ],
  ] satisfies EditorToolbarItem[][];
}

export function buildTableContextMenuActions(groups: EditorToolbarItem[][]) {
  return groups.flatMap((group, groupIndex) => {
    const mapped = group.map(
      (item) =>
        ({
          key: item.key,
          label: item.label,
          icon: item.icon,
          disabled: item.isDisabled?.(),
          tone: item.key === "delete-table" ? "danger" : "default",
          onSelect: () => {
            void Promise.resolve(item.run()).catch(() => {
              // The caller owns error presentation.
            });
          },
        }) satisfies ContextMenuAction,
    );

    if (groupIndex === groups.length - 1) {
      return mapped;
    }

    return [...mapped, { type: "separator", key: `table-separator-${groupIndex}` } satisfies ContextMenuAction];
  });
}

/** Shared presentation and schema commands. Clipboard and business actions belong to the caller. */
export function buildEditorTextContextMenuActions({editor,readOnly,hasTextSelection,onCopy,onCut,onPaste,insertTable,onInsertImage,onInsertFile,canInsertImage=false,canInsertFile=false,assetBusy=null,onToggleCodeBlock,selectionActions=[],showUnavailableInsertions=false,onUnavailableAction}: {
  editor:Editor;readOnly:boolean;hasTextSelection:boolean;
  onCopy:()=>void;onCut:()=>void;onPaste:()=>void;
  insertTable?:()=>void;onInsertImage?:()=>unknown;onInsertFile?:()=>unknown;
  canInsertImage?:boolean;canInsertFile?:boolean;assetBusy?:null|'image'|'file';
  onToggleCodeBlock?:()=>void;selectionActions?:ContextMenuAction[];
  showUnavailableInsertions?:boolean;onUnavailableAction?:(title:string)=>void;
}):ContextMenuAction[] {
  const locked=()=>readOnly||editor.isDestroyed||!editor.isEditable;
  const guard=(run:()=>unknown)=>()=>{if(!locked())run();};
  const clipboard:ContextMenuAction={type:'quick-actions',key:'text-clipboard-actions',ariaLabel:'剪贴板',actions:[
    {key:'text-cut',label:'剪切',icon:Scissors,disabled:locked(),onSelect:guard(onCut)},
    {key:'text-copy',label:'复制',icon:Copy,onSelect:onCopy},
    {key:'text-paste',label:'粘贴',icon:Paperclip,disabled:locked(),onSelect:guard(onPaste)},
  ]};
  // Markdown's read-only menu offers copying only. Record keeps its existing disabled command layout.
  if(locked()&&!showUnavailableInsertions)return [{...clipboard,actions:clipboard.actions.filter(action=>action.key==='text-copy')}];
  type Command=keyof ChainedCommands;
  const command=(key:string,label:string,icon:LucideIcon,name:Command,args:unknown[]=[],active=false):ContextMenuInlineAction|null=>{
    if(typeof editor.commands[name as keyof typeof editor.commands]!=='function')return null;
    const apply=(chain:ChainedCommands)=>{
      const call=chain[name] as (...args:unknown[])=>ChainedCommands;
      return call(...args).run();
    };
    return {key,label,icon,active,disabled:locked()||!apply(editor.can().chain().focus()),onSelect:guard(()=>{
      if(name==='toggleCodeBlock'&&onToggleCodeBlock)onToggleCodeBlock();else apply(editor.chain().focus());
    })};
  };
  const compact=(items:(ContextMenuInlineAction|null)[])=>items.filter((item):item is ContextMenuInlineAction=>item!==null);
  const formats=compact([
    command('text-highlight','着重',Highlighter,'toggleHighlight',[],editor.isActive('highlight')),
    command('text-bold','加粗',Bold,'toggleBold',[],editor.isActive('bold')),
    command('text-italic','斜体',Italic,'toggleItalic',[],editor.isActive('italic')),
    command('text-strike','删除线',Strikethrough,'toggleStrike',[],editor.isActive('strike')),
    command('text-code','代码',Code2,'toggleCode',[],editor.isActive('code')),
  ]);
  const headings=[Heading1,Heading2,Heading3,Heading4].map((icon,index)=>command(`text-h${index+1}`,`标题 ${index+1}`,icon,'toggleHeading',[{level:index+1}],editor.isActive('heading',{level:index+1})));
  const quote=command('text-blockquote','引用',Quote,'toggleBlockquote',[],editor.isActive('blockquote'));
  const task=command('text-task-list','Todo 清单',ListTodo,'toggleTaskList',[],editor.isActive('taskList'));
  const code=command('text-code-block','代码',Code2,'toggleCodeBlock',[],editor.isActive('codeBlock'));
  const paragraphActive=editor.isActive('paragraph')&&!['blockquote','heading','bulletList','orderedList','taskList','codeBlock'].some(name=>editor.isActive(name));
  const blocks=compact([
    command('text-paragraph','文本',Type,'setParagraph',[],paragraphActive),...headings,
    command('text-bullet-list','项目符号列表',List,'toggleBulletList',[],editor.isActive('bulletList')),
    command('text-ordered-list','有序列表',ListOrdered,'toggleOrderedList',[],editor.isActive('orderedList')),task,code,quote,
  ]);
  const current=blocks.find(item=>item.active)??blocks[0];
  const shortcuts=compact([...headings,quote,task]).map(item=>({...item,key:item.key.replace('text-','shortcut-'),label:item.key==='text-task-list'?'Todo':item.label}));
  const actions:ContextMenuAction[]=[clipboard,{type:'separator',key:'text-clipboard-separator'}];
  if(current)actions.push({type:'submenu',key:'text-group-block',label:current.key==='text-paragraph'?'普通文本':current.label,icon:current.icon,selected:true,featured:true,disabled:blocks.every(item=>item.disabled),actions:blocks.map(({active,...item})=>({...item,selected:active}))});
  if(formats.length)actions.push({type:'inline-actions',key:'text-inline-format-actions',ariaLabel:'行内文本格式',columns:5,showLabels:false,actions:formats});
  if(shortcuts.length)actions.push({type:'inline-actions',key:'text-block-shortcut-actions',ariaLabel:'常用块样式',columns:6,showLabels:false,actions:shortcuts});
  if(hasTextSelection){
    if(selectionActions.length)actions.push({type:'separator',key:'text-inline-actions-separator'},...selectionActions);
  }else{
    const insertions=compact([
      quote&&{...quote,key:'insert-blockquote'},
      (insertTable||showUnavailableInsertions)?{key:'insert-table',label:'表格',icon:Table2,disabled:locked()||!insertTable,onSelect:guard(()=>insertTable?.())}:null,
      (onInsertImage||showUnavailableInsertions)?{key:'insert-image',label:'图片',icon:Image,disabled:locked()||!canInsertImage||assetBusy!==null,onSelect:guard(()=>onInsertImage?.())}:null,
      (onInsertFile||showUnavailableInsertions)?{key:'insert-file',label:'文件',icon:FileIcon,disabled:locked()||!canInsertFile||assetBusy!==null,onSelect:guard(()=>onInsertFile?.())}:null,
      code&&{...code,key:'insert-code-block',label:'代码块'},task&&{...task,key:'insert-task-list',label:'Todo'},
      command('insert-divider','分隔线',Minus,'setHorizontalRule'),
      showUnavailableInsertions?{key:'insert-more-blocks',label:'更多',icon:MoreHorizontal,disabled:true,onSelect:()=>onUnavailableAction?.('更多')}:null,
    ]);
    if(insertions.length)actions.push({type:'separator',key:'text-inline-actions-separator'},{type:'grid-actions',key:'insert-block-grid',title:'新增区块',ariaLabel:'新增区块',columns:2,actions:insertions});
  }
  return actions;
}
