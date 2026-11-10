import {EditorView} from '@codemirror/view';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ProjectFileContent} from './ProjectFileContent';
import {fileWorkingApi} from '../../services/fileWorkingApi';
import {fileDocumentApi} from '../../services/fileDocumentApi';
import {fileBytes} from '../../services/projectFileApi';
import {projectFileApi} from '../../services/projectFileApi';
import {recordDocumentApi} from '../../services/recordDocumentApi';
import {officeFileApi} from '../../services/officeFileApi';

vi.mock('../../services/fileDocumentApi', () => ({fileDocumentApi:{versionsList:vi.fn(), sourceRead:vi.fn()}}));
vi.mock('../../services/recordDocumentApi', () => ({recordDocumentApi:{bindingGet:vi.fn()}}));
vi.mock('../../services/projectFileApi', () => ({projectFileApi:{resolve:vi.fn(), applications:vi.fn(), readBytes:vi.fn()}, fileBytes:vi.fn()}));
vi.mock('../../services/fileWorkingApi', () => ({fileWorkingApi:{open:vi.fn(), close:vi.fn(), saveOffice:vi.fn(), saveText:vi.fn(), activity:vi.fn()}}));
vi.mock('../../services/officeFileApi', () => ({officeFileApi:{inspect:vi.fn()}}));
// Only native I/O and the renderer-side MessagePort are controlled. The File
// host, XlsxEditor and its bundled production frame bridge remain real.

const object = {workspaceId:'w', scope:{kind:'project' as const, projectId:2}, kind:'file' as const, id:'7'};
const binding = {workspaceId:'w', generation:'g'};
const model = {format:'xlsx' as const, name:'sample.xlsx', activeSheetId:'s1', sheets:[], ranges:{}, styles:[], visuals:[], definedNames:[], date1904:false};
const status = {object, revision:2, contentHash:'hash2', archivedVersionNumber:2, pendingArchive:false, lastActivityAtMs:0, archiveDueAtMs:900000, noChange:false};
type Packet = {type:string; id?:number; value?:unknown};
class TestChannel {
  static latest: TestChannel;
  port1 = {postMessage:vi.fn<(packet:Packet) => void>(), start:vi.fn(), close:vi.fn(), onmessage:null as ((event:{data:unknown}) => void) | null};
  port2 = {};
  constructor() { TestChannel.latest=this; }
  receive(type:string, value?:unknown, id?:number) { this.port1.onmessage?.({data:{officeXlsx:true, type, value, id}}); }
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('MessageChannel', TestChannel);
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectFileApi.applications).mockResolvedValue([]);
  vi.mocked(projectFileApi.resolve).mockResolvedValue({object, relativePath:'sample.xlsx', name:'sample.xlsx', versionNumber:2, contentHash:'hash2', state:'ready', reason:null});
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object, currentVersionNumber:2, currentContentHash:'hash2', versions:[2,1].map(n => ({id:String(n), versionNumber:n, name:'sample.xlsx', createdAt:'', contentHash:`hash${n}`, isCurrent:n===2})), nextCursor:null});
  vi.mocked(fileWorkingApi.open).mockResolvedValue({...status, sessionId:'session2', name:'sample.xlsx', base64:'UEs=', format:'xlsx', model});
  vi.mocked(fileWorkingApi.activity).mockResolvedValue(status);
  vi.mocked(fileWorkingApi.close).mockResolvedValue();
  vi.mocked(officeFileApi.inspect).mockResolvedValue({model} as never);
});
afterEach(() => vi.unstubAllGlobals());

it.each(['success','capture failure','save failure'])('waits for Office active-input/IME capture and native save: %s', async outcome => {
  const client=new QueryClient();
  const onViewChange=vi.fn();
  const wrap=(versionNumber?:number) => <QueryClientProvider client={client}><ProjectFileContent workspaceRoot="/workspace" projectId={2} fileId={7} visible focused versionNumber={versionNumber} fileName="sample.xlsx" onViewChange={onViewChange}/></QueryClientProvider>;
  let finish!: () => void;
  vi.mocked(fileWorkingApi.saveOffice).mockImplementationOnce(() => new Promise((resolve,reject) => {finish=() => outcome==='save failure' ? reject(Error('写入失败')) : resolve({...status, revision:3, contentHash:'hash3', pendingArchive:true});}));
  const view=render(wrap());
  const edit=await screen.findByRole('button', {name:'编辑', exact:true});
  await waitFor(() => expect(edit).not.toBeDisabled());
  fireEvent.click(edit);
  await waitFor(() => expect(view.container.querySelector('iframe')).not.toBeNull());
  const frame=view.container.querySelector('iframe')!;
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {});
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', {source:frame.contentWindow, data:{officeXlsx:true, type:'bootstrap'}}));
    TestChannel.latest.receive('ready');
    // The real renderer reports pending while a cell or IME input has not yet
    // entered its journal. Hold the commit reply to model that capture barrier.
    TestChannel.latest.receive('pending', true);
  });
  const channel=TestChannel.latest;
  view.rerender(wrap(1));
  await waitFor(() => expect(channel.port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'commit'})));
  const commit=channel.port1.postMessage.mock.calls.map(([packet]) => packet).find(packet => packet.type==='commit')!;
  expect(view.container.querySelector('iframe')).toBe(frame);
  expect(fileWorkingApi.close).not.toHaveBeenCalled();
  expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
  const edits=[{kind:'string', sheetId:'s1', row:0, column:0, value:'输入法草稿'}];
  await act(async () => {
    if (outcome==='capture failure') channel.receive('reply', {error:'输入法尚未完成'}, commit.id);
    else {
      channel.receive('change', {edits, editRevision:1});
      channel.receive('pending', false);
      channel.receive('reply', {result:null}, commit.id);
    }
  });
  if (outcome==='capture failure') {
    await screen.findByText('输入法尚未完成', {selector:'.project-file-content > [role="alert"]'});
    expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
  } else {
    await waitFor(() => expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding, expect.objectContaining({sessionId:'session2', expectedRevision:2, edits}), expect.any(String)));
    expect(view.container.querySelector('iframe')).toBe(frame);
    expect(fileWorkingApi.close).not.toHaveBeenCalled();
    await act(async () => finish());
  }
  if (outcome==='success') {
    await waitFor(() => expect(screen.getByRole('button', {name:'文件查看版本'})).toHaveTextContent('v1'));
    expect(fileWorkingApi.close).toHaveBeenCalledOnce();
    expect(channel.port1.close).toHaveBeenCalledOnce();
  } else {
    await waitFor(() => expect(onViewChange).toHaveBeenCalledWith({versionNumber:undefined}));
    expect(view.container.querySelector('iframe')).toBe(frame);
    expect(channel.port1.close).not.toHaveBeenCalled();
    expect(fileWorkingApi.close).not.toHaveBeenCalled();
    expect(screen.getByRole('button', {name:'文件查看版本'})).toHaveTextContent('当前内容');
  }
  view.unmount();
});

it('retains the actual Markdown source editor through IME capture and native save', async () => {
  Object.defineProperty(Range.prototype, 'getClientRects', {configurable:true, value:() => []});
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {configurable:true, value:() => new DOMRect()});
  const text='original';
  vi.mocked(projectFileApi.resolve).mockResolvedValue({object, relativePath:'sample.md', name:'sample.md', versionNumber:2, contentHash:'hash2', state:'ready', reason:null});
  vi.mocked(fileWorkingApi.open).mockResolvedValue({...status, sessionId:'session2', name:'sample.md', base64:btoa(text), format:'markdown', model:null});
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object, currentVersionNumber:2, currentContentHash:'hash2', versions:[2,1].map(n => ({id:String(n), versionNumber:n, name:'sample.md', createdAt:'', contentHash:`hash${n}`, isCurrent:n===2})), nextCursor:null});
  vi.mocked(fileBytes).mockImplementation(result => Uint8Array.from(atob(result.base64), c => c.charCodeAt(0)));
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({object, name:'sample.md', versionNumber:1, contentHash:'hash1', mime:'text/markdown', base64:btoa('history'), byteLength:7});
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue({object, title:'sample.md', versionNumber:1, contentHash:'hash1', format:'markdown', text:'history', byteLength:7, startChar:0, endChar:7, totalChars:7, nextCursor:null, complete:true});
  let finish!: () => void;
  vi.mocked(fileWorkingApi.saveText).mockImplementationOnce(() => new Promise(resolve => {finish=() => resolve({...status, revision:3, contentHash:'hash3', pendingArchive:true});}));
  const client=new QueryClient();
  const wrap=(versionNumber?:number) => <QueryClientProvider client={client}><ProjectFileContent workspaceRoot="/workspace" projectId={2} fileId={7} visible focused initialSourceMode versionNumber={versionNumber}/></QueryClientProvider>;
  const view=render(wrap());
  const source=await screen.findByRole('textbox', {name:'Markdown 源码'});
  const editor=EditorView.findFromDOM(source)!;
  act(() => {fireEvent.compositionStart(source); editor.dispatch({changes:{from:editor.state.doc.length, insert:' IME draft'}});});
  view.rerender(wrap(1));
  await act(async () => {});
  expect(screen.getByRole('textbox', {name:'Markdown 源码'})).toBe(source);
  expect(fileWorkingApi.saveText).not.toHaveBeenCalled();
  expect(fileWorkingApi.close).not.toHaveBeenCalled();
  fireEvent.compositionEnd(source);
  await waitFor(() => expect(fileWorkingApi.saveText).toHaveBeenCalledWith(binding, expect.objectContaining({sessionId:'session2', text:'original IME draft'}), expect.any(String)));
  expect(screen.getByRole('textbox', {name:'Markdown 源码'})).toBe(source);
  expect(fileWorkingApi.close).not.toHaveBeenCalled();
  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole('textbox', {name:'Markdown 源码'})).toHaveTextContent('history'));
  expect(fileWorkingApi.close).toHaveBeenCalledOnce();
  view.unmount();
});
