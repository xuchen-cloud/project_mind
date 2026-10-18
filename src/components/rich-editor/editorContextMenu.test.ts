import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { CellSelection } from '@tiptap/pm/tables';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buildEditorTextContextMenuActions, buildTableContextMenuActions, buildTableToolbarGroups } from './editorContextMenu';
import type { ContextMenuAction } from '../../ui/components/ActionContextMenu';
const editors:Editor[]=[];
beforeAll(()=>{
  Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:()=>[]});
  Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>new DOMRect()});
});
afterEach(()=>{editors.splice(0).forEach(editor=>editor.destroy());});
function setup(){const editor=new Editor({extensions:[StarterKit,TableKit,TaskList,TaskItem],content:'<p>hello world</p>'});editors.push(editor);return editor;}
function actions(editor:Editor){return buildEditorTextContextMenuActions({editor,readOnly:false,hasTextSelection:true,onCopy:vi.fn(),onCut:vi.fn(),onPaste:vi.fn()});}
function find(items:ContextMenuAction[],key:string):()=>void{
 for(const item of items){
  if(item.key===key&&'onSelect' in item)return item.onSelect;
  if('actions' in item){for(const child of item.actions){if(child.key===key&&'onSelect' in child)return child.onSelect;}}
 }
 throw new Error(`Missing action ${key}`);
}
it('shares real inline, heading, list and code commands without requiring highlight',()=>{
 const editor=setup();editor.commands.setTextSelection({from:1,to:6});
 find(actions(editor),'text-bold')();expect(editor.getHTML()).toContain('<strong>hello</strong>');
 find(actions(editor),'shortcut-h4')();expect(editor.isActive('heading',{level:4})).toBe(true);
 find(actions(editor),'text-paragraph')();find(actions(editor),'text-task-list')();expect(editor.isActive('taskList')).toBe(true);
 find(actions(editor),'text-task-list')();find(actions(editor),'text-code-block')();expect(editor.isActive('codeBlock')).toBe(true);
 expect(()=>find(actions(editor),'text-highlight')).toThrow('Missing action');
});
it('lets records inject code-language, clipboard and business actions without importing record services',()=>{
 const editor=setup();const copy=vi.fn();const code=vi.fn(()=>{editor.commands.toggleCodeBlock({language:'typescript'});});const skill=vi.fn();
 const items=buildEditorTextContextMenuActions({editor,readOnly:false,hasTextSelection:true,onCopy:copy,onCut:vi.fn(),onPaste:vi.fn(),onToggleCodeBlock:code,selectionActions:[{key:'skill',label:'Skill',onSelect:skill}]});
 find(items,'text-copy')();expect(copy).toHaveBeenCalledOnce();find(items,'text-code-block')();expect(editor.getJSON().content?.[0].attrs?.language).toBe('typescript');
 find(items,'skill')();expect(skill).toHaveBeenCalledOnce();
});
it('rejects a stale format or table action after the editor becomes read-only',()=>{
 const editor=setup();editor.commands.setTextSelection({from:1,to:6});const bold=find(actions(editor),'text-bold');
 editor.commands.insertTable({rows:2,cols:2,withHeaderRow:true});const row=find(buildTableContextMenuActions(buildTableToolbarGroups(editor,false)),'add-row-after');
 const before=editor.getJSON();editor.setEditable(false);bold();row();expect(editor.getJSON()).toEqual(before);
});
it('merges real table cells through the same table menu builder',()=>{
 const editor=setup();editor.commands.insertTable({rows:2,cols:2,withHeaderRow:false});
 const cells:number[]=[];editor.state.doc.descendants((node,pos)=>{if(node.type.name==='tableCell')cells.push(pos);});
 editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc,cells[0],cells[1])));
 const menu=buildTableContextMenuActions(buildTableToolbarGroups(editor,false));
 const merge=menu.find(item=>item.key==='merge-cells');expect(merge&&'disabled' in merge&&merge.disabled).toBe(false);
 find(menu,'merge-cells')();expect(editor.getJSON().content?.find(node=>node.type==='table')?.content?.[0].content?.[0].attrs?.colspan).toBe(2);
 find(buildTableContextMenuActions(buildTableToolbarGroups(editor,false)),'split-cell')();
 const table=editor.getJSON().content?.find(node=>node.type==='table');expect(table?.content?.[0].content).toHaveLength(2);
});
