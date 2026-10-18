import {act,fireEvent,render,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import {EditorFileMenu} from './EditorFileMenu';

it.each(['docx','xlsx','pptx','markdown'] as const)('%s uses the host icon menu with common output names and order',format=>{
 const output=vi.fn();
 const view=render(<EditorFileMenu format={format} onSelect={output}/>);
 const trigger=screen.getByRole('button',{name:'文件菜单'});
 expect(trigger).toHaveTextContent('');
 fireEvent.keyDown(trigger,{key:'ArrowDown'});
 const items=screen.getAllByRole('menuitem');
 expect(items[0]).toHaveTextContent('导出 PDF');
 expect(items.at(-1)).toHaveTextContent('打印…');
 expect(items.map(item=>item.textContent)).not.toContain('保存');
 fireEvent.click(items[0]);expect(output).toHaveBeenCalledWith('pdf');
 expect(screen.queryByRole('menu')).not.toBeInTheDocument();
 view.unmount();
});
it('closes the old File menu when the document changes',()=>{
 const onSelect=vi.fn();const view=render(<EditorFileMenu format="docx" documentKey="a" onSelect={onSelect}/>);
 fireEvent.click(screen.getByRole('button',{name:'文件菜单'}));
 expect(screen.getByRole('menu')).toBeVisible();
 act(()=>view.rerender(<EditorFileMenu format="pptx" documentKey="b" onSelect={onSelect}/>));
 expect(screen.queryByRole('menu')).not.toBeInTheDocument();expect(onSelect).not.toHaveBeenCalled();view.unmount();
});
