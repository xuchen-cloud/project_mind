import {StrictMode} from 'react';
import {EditorView} from '@codemirror/view';
import {act,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {beforeAll,expect,it,vi} from 'vitest';
import {MarkdownEditor} from './MarkdownEditor';

// JSDOM has no text geometry; CodeMirror measures ranges after a line jump.
beforeAll(()=>{
 Object.defineProperty(Range.prototype,'getClientRects',{configurable:true,value:()=>[]});
 Object.defineProperty(Range.prototype,'getBoundingClientRect',{configurable:true,value:()=>new DOMRect()});
});

it('defaults to editable blocks with one icon toolbar and ignores legacy presentationMode',async()=>{
 const changed=vi.fn();
 const props={value:'# 中文标题\n\n**保留粗体**\n\n![图](data:image/png;base64,iVBORw0KGgo=)\n',onChange:changed,presentationMode:'preview' as const};
 const view=render(<StrictMode><MarkdownEditor {...props}/></StrictMode>);
 const editor=await screen.findByRole('textbox',{name:'Markdown 块编辑'});
 await waitFor(()=>expect(editor).toHaveTextContent('中文标题'));
 expect(editor.querySelector('strong')).toHaveTextContent('保留粗体');
 expect(editor.querySelector('img')).toBeTruthy();
 expect(editor).toHaveAttribute('contenteditable','true');
 const toolbar=screen.getByRole('toolbar',{name:'Markdown 工具'});
 expect(toolbar.textContent).toBe('');
 expect(within(toolbar).getAllByRole('button')).toHaveLength(13);
 for(const name of ['分屏','预览','粗体','斜体','删除线','行内代码','链接','无序列表','有序列表','任务列表','代码块','分隔线'])expect(screen.queryByRole('button',{name,exact:true})).not.toBeInTheDocument();
 expect(screen.queryByRole('combobox',{name:'段落格式'})).not.toBeInTheDocument();
 expect(screen.queryByRole('textbox',{name:'定位行号'})).not.toBeInTheDocument();
 expect(screen.queryByRole('textbox',{name:'Markdown 源码'})).not.toBeInTheDocument();
 view.rerender(<StrictMode><MarkdownEditor {...props} presentationMode="edit" readOnly/></StrictMode>);
 expect(screen.getByRole('textbox',{name:'Markdown 块编辑'})).toBe(editor);
 await waitFor(()=>expect(editor).toHaveAttribute('contenteditable','false'));
 expect(screen.getByRole('toolbar')).toBeVisible();
 expect(screen.getByRole('button',{name:'图片',exact:true})).toBeDisabled();
 expect(screen.getByRole('button',{name:'查找替换'})).toBeEnabled();
 view.rerender(<StrictMode><MarkdownEditor {...props} presentationMode="preview" readOnly={false}/></StrictMode>);
 await waitFor(()=>expect(editor).toHaveAttribute('contenteditable','true'));
 fireEvent.click(screen.getByRole('button',{name:'源码',exact:true}));
 const source=await screen.findByRole('textbox',{name:'Markdown 源码'});
 expect(source).toHaveTextContent('中文标题');
 fireEvent.click(screen.getByRole('button',{name:'块编辑',exact:true}));
 expect(screen.getByRole('textbox',{name:'Markdown 块编辑'})).toBe(editor);
 expect(changed).not.toHaveBeenCalled();
});

it.each(['source','split','preview','rich'] as const)('normalizes persisted %s mode to source or rich',async mode=>{
 const view=render(<MarkdownEditor value="# 标题" onChange={()=>{}} initialView={{mode}}/>);
 const target=mode==='source'?'Markdown 源码':'Markdown 块编辑';
 await screen.findByRole('textbox',{name:target});
 expect(view.container.querySelector('section')).toHaveAttribute('data-mode',mode==='source'?'source':'rich');
});

it('automatically opens source and retains external line jumps through lazy loading and document replacement',async()=>{
 const changed=vi.fn(),viewChanged=vi.fn();
 const props={value:'# 标题\n\n第三行\n第四行',onChange:changed,onViewChange:viewChanged,documentKey:'a'};
 const view=render(<MarkdownEditor {...props}/>);
 const rich=await screen.findByRole('textbox',{name:'Markdown 块编辑'});
 view.rerender(<MarkdownEditor {...props} line={3}/>);
 const source=await screen.findByRole('textbox',{name:'Markdown 源码'});
 await waitFor(()=>{const editor=EditorView.findFromDOM(source);expect(editor?.state.selection.main.from).toBe(editor?.state.doc.line(3).from);});
 expect(viewChanged).toHaveBeenCalledWith({mode:'source',sourceMode:true});
 fireEvent.click(screen.getByRole('button',{name:'块编辑',exact:true}));
 expect(screen.getByRole('textbox',{name:'Markdown 块编辑'})).toBe(rich);
 view.rerender(<MarkdownEditor {...props} value={'新文档\n第二行\n第三行\n第四行\n最终目标'} documentKey="b" line={5}/>);
 await waitFor(()=>{const editor=EditorView.findFromDOM(source);expect(editor?.state.doc.toString()).toContain('最终目标');expect(editor?.state.selection.main.from).toBe(editor?.state.doc.line(5).from);});
 expect(changed).not.toHaveBeenCalled();
});

it('supports initial line requests and sourceMode deep links without reinterpreting local mode changes',async()=>{
 const props={value:'一\n二\n三',onChange:vi.fn(),sourceMode:false};
 const view=render(<MarkdownEditor {...props} line={3}/>);
 const source=await screen.findByRole('textbox',{name:'Markdown 源码'});
 await waitFor(()=>expect(EditorView.findFromDOM(source)?.state.selection.main.from).toBe(4));
 fireEvent.click(screen.getByRole('button',{name:'块编辑',exact:true}));
 await screen.findByRole('textbox',{name:'Markdown 块编辑'});
 view.rerender(<MarkdownEditor {...props} sourceMode/>);
 expect(source).toBeVisible();
 view.rerender(<MarkdownEditor {...props}/>);
 await screen.findByRole('textbox',{name:'Markdown 块编辑'});
});

it('keeps actual table insertion and undo available in blocks, and source edits across mode changes',async()=>{
 const changed=vi.fn();
 render(<MarkdownEditor value="# 原文\n\n正文" onChange={changed}/>);
 const rich=await screen.findByRole('textbox',{name:'Markdown 块编辑'});
 fireEvent.click(screen.getByRole('button',{name:'表格',exact:true}));
 await waitFor(()=>expect(rich.querySelector('table')).toBeTruthy());
 expect(changed.mock.lastCall?.[0]).toContain('|');
 fireEvent.click(screen.getByRole('button',{name:'撤销',exact:true}));
 await waitFor(()=>expect(rich.querySelector('table')).toBeNull());
 fireEvent.click(screen.getByRole('button',{name:'源码',exact:true}));
 const source=await screen.findByRole('textbox',{name:'Markdown 源码'});
 const controller=EditorView.findFromDOM(source)!;
 act(()=>controller.dispatch({changes:{from:controller.state.doc.length,insert:'\n\n源码追加'}}));
 fireEvent.click(screen.getByRole('button',{name:'块编辑',exact:true}));
 expect(screen.getByRole('textbox',{name:'Markdown 块编辑'})).toBe(rich);
 await waitFor(()=>expect(rich).toHaveTextContent('源码追加'));
});

it('offers dismissible image and YAML panels, preserves source bytes and does not insert on cancel',async()=>{
 const changed=vi.fn(),value='\uFEFF---\r\ntitle: 原名\r\n---\r\n\r\n# 标题\r\n';
 render(<MarkdownEditor value={value} onChange={changed} initialView={{mode:'source'}}/>);
 await screen.findByRole('textbox',{name:'Markdown 源码'});
 fireEvent.click(screen.getByRole('button',{name:'图片',exact:true}));
 fireEvent.change(screen.getByRole('textbox',{name:'目标地址'}),{target:{value:'images/图.png'}});
 fireEvent.click(screen.getByRole('button',{name:'取消',exact:true}));
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 expect(changed).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'前置信息',exact:true}));
 fireEvent.change(screen.getByRole('textbox',{name:'YAML 前置信息'}),{target:{value:'title: 新名'}});
 expect(changed).toHaveBeenLastCalledWith(value.replace('原名','新名'));
 expect(screen.getByRole('textbox',{name:'YAML 前置信息'})).toHaveFocus();
 fireEvent.keyDown(document.activeElement!,{key:'Escape'});
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'图片',exact:true}));
 fireEvent.change(screen.getByRole('textbox',{name:'目标地址'}),{target:{value:'images/图.png'}});
 fireEvent.change(screen.getByRole('textbox',{name:'显示文字'}),{target:{value:'示意图'}});
 fireEvent.click(screen.getByRole('button',{name:'插入',exact:true}));
 expect(changed.mock.lastCall?.[0]).toContain('![示意图](images/图.png)');
 expect(changed.mock.lastCall?.[0]).toMatch(/^\uFEFF/u);
 expect(changed.mock.lastCall?.[0]).toContain('\r\n');
});

it('finds and replaces actual block content, and keeps readonly search without mutation',async()=>{
 const changed=vi.fn();
 const view=render(<MarkdownEditor value="查找词 和 查找词" onChange={changed}/>);
 const rich=await screen.findByRole('textbox',{name:'Markdown 块编辑'});
 fireEvent.click(screen.getByRole('button',{name:'查找替换'}));
 fireEvent.change(screen.getByRole('textbox',{name:'查找',exact:true}),{target:{value:'查找词'}});
 await waitFor(()=>expect(within(screen.getByRole('search')).getByRole('status')).toHaveTextContent('1 / 2'));
 fireEvent.change(screen.getByRole('textbox',{name:'替换为'}),{target:{value:'替换结果'}});
 fireEvent.click(screen.getByRole('button',{name:'全部替换'}));
 await waitFor(()=>expect(rich).toHaveTextContent('替换结果 和 替换结果'));
 fireEvent.keyDown(screen.getByRole('textbox',{name:'查找',exact:true}),{key:'Escape'});
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
 view.rerender(<MarkdownEditor value="只读 查找词" onChange={changed} readOnly/>);
 fireEvent.click(screen.getByRole('button',{name:'查找替换'}));
 expect(screen.getByRole('textbox',{name:'替换为'})).toBeDisabled();
 expect(screen.getByRole('button',{name:'全部替换'})).toBeDisabled();
 fireEvent.pointerDown(rich);
 expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('keeps slider, minus, plus and percentage connected to the same zoom across source and blocks',async()=>{
 const viewChanged=vi.fn();
 render(<MarkdownEditor value="# 缩放" onChange={()=>{}} onViewChange={viewChanged} readOnly/>);
 const rich=await screen.findByRole('textbox',{name:'Markdown 块编辑'});
 fireEvent.change(screen.getByRole('slider'),{target:{value:'150'}});
 expect(screen.getByRole('button',{name:'缩放百分比'})).toHaveTextContent('150%');
 expect(rich.closest('.mind-markdown__rich-page')).toHaveStyle({'--md-zoom':'1.5'});
 expect(viewChanged).toHaveBeenLastCalledWith({zoom:150});
 fireEvent.click(screen.getByRole('button',{name:'缩小',exact:true}));
 expect(screen.getByRole('slider')).toHaveValue('140');
 fireEvent.click(screen.getByRole('button',{name:'放大',exact:true}));
 expect(screen.getByRole('slider')).toHaveValue('150');
 fireEvent.click(screen.getByRole('button',{name:'源码',exact:true}));
 await screen.findByRole('textbox',{name:'Markdown 源码'});
 expect(screen.getByRole('slider')).toHaveValue('150');
 fireEvent.click(screen.getByRole('button',{name:'缩放百分比'}));
 expect(screen.getByRole('slider')).toHaveValue('100');
 expect(screen.getByText('只读')).toBeVisible();
});

it('keeps the real body-mounted math editor dismissible and applies formulas to blocks',async()=>{
 const changed=vi.fn();
 render(<MarkdownEditor value="正文" onChange={changed}/>);
 await screen.findByRole('textbox',{name:'Markdown 块编辑'});
 fireEvent.click(screen.getByRole('button',{name:'公式',exact:true}));
 const input=screen.getByPlaceholderText(/输入 LaTeX 公式/u);
 expect(input.closest('.md-math-pop')?.parentElement).toBe(document.body);
 fireEvent.keyDown(input,{key:'Escape'});
 expect(document.querySelector('.md-math-pop')).toBeNull();
 expect(changed).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'公式',exact:true}));
 fireEvent.change(screen.getByPlaceholderText(/输入 LaTeX 公式/u),{target:{value:'x^2'}});
 fireEvent.click(screen.getByRole('button',{name:'应用',exact:true}));
 await waitFor(()=>expect(changed.mock.lastCall?.[0]).toContain('x^2'));
 expect(document.querySelector('.md-math-pop')).toBeNull();
});
