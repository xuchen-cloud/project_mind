import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryAdoption } from './MemoryAdoption';
import { MemoryAdoptionRenderer, MemoryAdoptionTail } from '../../../packages/dsh-ui/adapters/memory-adoption.jsx';
const mock=vi.hoisted(()=>({binding:vi.fn(),adoption:vi.fn()}));
vi.mock('../../services/recordDocumentApi',()=>({recordDocumentApi:{bindingGet:mock.binding}}));
vi.mock('../../services/memoryApi',()=>({memoryApi:{adoption:mock.adoption}}));
const saved=(text:string,step=1)=>({requestId:`request-${step}`,adoptedAt:'2026-10-01',snapshot:{turn:4,step,facts:[{id:'fact',content:text,condition:'当时条件',revision:1}],omittedIds:['unloaded']}});
beforeEach(()=>{mock.binding.mockReset().mockResolvedValue({workspaceId:'workspace',generation:'actual'});mock.adoption.mockReset().mockResolvedValue([saved('当时的第一版'),saved('当时的第二版',2)]);});
function open(){fireEvent.click(screen.getByText('这次回答使用的记忆'));}
it('official turn-tail passes actual Session and turn, lazily reads only that answer and shows each step',async()=>{
  render(<MemoryAdoptionRenderer.Provider value={({sessionId,turn}:{sessionId:string;turn:number})=><MemoryAdoption workspaceRoot="/workspace" projectId={7} sessionId={sessionId} turn={turn}/>}><MemoryAdoptionTail sessionId="real-session" turn={{turn:4}}/></MemoryAdoptionRenderer.Provider>);
  expect(mock.binding).not.toHaveBeenCalled(); expect(mock.adoption).not.toHaveBeenCalled();
  open(); await screen.findByText('当时的第一版');
  expect(mock.adoption).toHaveBeenCalledWith({workspaceId:'workspace',generation:'actual'},{kind:'project',projectId:7},'real-session',4);
  expect(screen.getByText('当时的第二版')).toBeInTheDocument();
  expect(screen.getAllByText('1 条因本次预算未装入，保存的记忆未变。')).toHaveLength(2);
});
it('changing Workspace or answer closes and clears old content; stale responses never appear',async()=>{
  let resolve!: (value:unknown)=>void;
  mock.adoption.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const view=render(<MemoryAdoption workspaceRoot="/old" projectId={null} sessionId="session" turn={1}/>);
  open(); await waitFor(()=>expect(mock.adoption).toHaveBeenCalledTimes(1));
  view.rerender(<MemoryAdoption workspaceRoot="/new" projectId={null} sessionId="session" turn={2}/>);
  await act(async()=>resolve([saved('旧工作区秘密')]));
  expect(screen.queryByText('旧工作区秘密')).toBeNull();
  expect(screen.getByRole('button',{name:'这次回答使用的记忆'})).toHaveAttribute('aria-expanded','false');
  expect(mock.adoption).toHaveBeenCalledTimes(1);
  open(); await screen.findByText('当时的第一版');
  expect(mock.binding).toHaveBeenLastCalledWith('/new');
  expect(mock.adoption).toHaveBeenLastCalledWith(expect.anything(),{kind:'workspace'},'session',2);
  view.rerender(<MemoryAdoption workspaceRoot="/new" projectId={null} sessionId="session" turn={3}/>);
  expect(screen.queryByText('当时的第一版')).toBeNull();
  expect(mock.adoption).toHaveBeenCalledTimes(2);
});
