import { useEffect, useRef, useState } from "react";
import type { AgentError, AgentSourceRef } from "../../lib/agent-types";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { htmlPreviewApi } from "../../services/htmlPreviewApi";
import { ProjectFileContent } from "./ProjectFileContent";
import { ProjectFileIdentityActions } from "./ProjectFileIdentityActions";
import { ProjectContentMoveContext } from "../../lib/project-content-move-context";
import { officeFileApi } from "../../services/officeFileApi";
import {fileWorkingApi} from "../../services/fileWorkingApi";
import { officePreviewCache } from "../../lib/office-preview-cache";
import { desktopApi } from "../../services/desktopApi";
import { agentApi, AgentApiError } from "../../services/agentApi";
import { ProjectContentLayoutView } from "../project/ProjectContentLayoutView";
import { registerProjectContentCloseGuard, releaseContentOwnerMove, withProjectContentMove } from "../../lib/project-content-lifecycle";
import { fileEditorApi } from "../../services/fileEditorApi";
vi.mock("../../services/fileEditorApi", () => ({fileEditorApi:{register:vi.fn(),unregister:vi.fn(),reply:vi.fn()}}));
vi.mock("../../services/fileWorkingApi",()=>({fileWorkingApi:{open:vi.fn(),saveOffice:vi.fn(),activity:vi.fn(),tick:vi.fn(),close:vi.fn()}}));
vi.mock("../../services/officeFileApi", () => ({ officeFileApi: { inspect: vi.fn(), save: vi.fn() } }));
// The editor components are mocked; their runtime preloads must not compile unused vendor bundles.
vi.mock("../../../packages/office-docx/dist/editor.mjs", () => ({}));
vi.mock("../../../packages/office-xlsx/dist/browser.mjs", () => ({}));
vi.mock("../office/DocxEditor", () => ({ DocxEditor: (props: { model: {nodes?: {text?: string}[]}; edits: { text: string }[]; onChange: (edits: unknown[]) => void; readOnly: boolean }) => <input aria-label="Office 正文" disabled={props.readOnly} value={props.edits[0]?.text ?? props.model.nodes?.[0]?.text ?? "原文"} onChange={event => props.onChange([{ type: "text", nodeId: "p0", text: event.target.value }])} /> }));
vi.mock("../office/XlsxEditor", () => ({ XlsxEditor: (props: { registerBeforeSave: (commit: () => Promise<void>) => () => void; onPendingChange: (pending: boolean) => void; onChange: (edits: unknown[]) => void }) => {
  const pending = useRef<string | null>(null);
  const latest = useRef(props); latest.current = props;
  useEffect(() => props.registerBeforeSave(async () => {
    if (pending.current === null) return;
    latest.current.onChange([{ sheetId: 'sheet-1', row: 0, column: 0, kind: 'string', value: pending.current }]);
    pending.current = null;
    latest.current.onPendingChange(false);
  }), [props.registerBeforeSave]);
  return <input aria-label="Office 正文" onChange={event => { pending.current = event.target.value; props.onPendingChange(true); }} />;
} }));
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn(), sourceRead: vi.fn(), versionMetadataUpdate: vi.fn() } }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { readBytes: vi.fn(), resolve: vi.fn(), resolveRelated: vi.fn(), reconcile: vi.fn(), openLocal: vi.fn(), applications: vi.fn(), openWith: vi.fn() }, fileBytes: (result: { base64: string }) => Uint8Array.from(atob(result.base64), c => c.charCodeAt(0)) }));
vi.mock("../../services/htmlPreviewApi", () => ({ htmlPreviewApi: { create: vi.fn(), layout: vi.fn(), action: vi.fn(), status: vi.fn(), close: vi.fn() } }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
const input = { workspaceRoot: "/workspace", projectId: 2, fileId: 7, visible: true, focused: true };
const version = (n: number) => ({ id: String(n), versionNumber: n, name: "sample.txt", createdAt: "2026-10-11", contentHash: `hash${n}`, isCurrent: n === 2 });
function source(n: number, text = `version${n}`, name = "sample.txt", format: "text" | "markdown" | "html" = "text") {
  return { object, versionNumber: n, contentHash: `hash${n}`, title: name, byteLength: new TextEncoder().encode(text).byteLength, format, text, startChar: 0, endChar: [...text].length, totalChars: [...text].length, nextCursor: null, complete: true };
}
async function chooseVersion(version: number) {
  fireEvent.click(screen.getByRole("button", { name: "文件查看版本" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: `v${version}`, exact: true }));
}
function view(props = input, moveState?: { committed: boolean; nativeSessionsClosed?: boolean }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (next: typeof input) => <QueryClientProvider client={client}><ProjectContentMoveContext.Provider value={moveState ?? null}><ProjectFileContent {...next} /></ProjectContentMoveContext.Provider></QueryClientProvider>;
  return { ...render(wrap(props)), wrap, client };
}
beforeEach(() => {
  officePreviewCache.clear();
  vi.resetAllMocks();
  vi.mocked(fileWorkingApi.activity).mockResolvedValue(workingStatus());
  vi.mocked(fileWorkingApi.tick).mockResolvedValue(workingStatus());
  vi.mocked(fileWorkingApi.close).mockResolvedValue();
  let sequence = 0;
  vi.mocked(htmlPreviewApi.create).mockImplementation(async () => ({id:`native-${++sequence}`,url:'http://127.0.0.1:1234/'}));
  vi.mocked(htmlPreviewApi.layout).mockResolvedValue();
  vi.mocked(htmlPreviewApi.close).mockResolvedValue();
  vi.mocked(htmlPreviewApi.status).mockResolvedValue({url:'http://127.0.0.1:1234/',loading:false,diagnostics:[]});
  vi.spyOn(desktopApi, "confirm").mockResolvedValue(false);
  vi.spyOn(desktopApi, "listenEvent").mockResolvedValue(() => undefined);
  vi.mocked(fileEditorApi.register).mockResolvedValue(null);
  vi.mocked(fileEditorApi.unregister).mockResolvedValue(null);
  vi.mocked(fileEditorApi.reply).mockResolvedValue(null);
  vi.spyOn(agentApi, "statusGet").mockResolvedValue({ binding } as Awaited<ReturnType<typeof agentApi.statusGet>>);
  vi.mocked(projectFileApi.applications).mockResolvedValue([]);
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: "sample.txt", name: "sample.txt", versionNumber: 2, contentHash: "hash2", state: "ready", reason: null });
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: 2, currentContentHash: "hash2", versions: [version(2), version(1)], nextCursor: null });
  vi.mocked(projectFileApi.readBytes).mockImplementation(async (_binding, { versionNumber }) => ({ object, versionNumber, contentHash: `hash${versionNumber}`, name: "sample.txt", mime: "text/plain", byteLength: 8, base64: btoa(`version${versionNumber}`) }));
  vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_, data) => source(data.versionNumber));
});
function workingStatus(){return{object,revision:2,contentHash:'hash2',archivedVersionNumber:2,pendingArchive:false,lastActivityAtMs:null,archiveDueAtMs:null,noChange:false};}
function originalMissing() {
  return new AgentApiError({ code: 'SOURCE_NOT_READY', message: 'Original File is missing', details: { reason: 'original_missing' }, retryable: false });
}
it.each([true, false])('opens a legacy File after explicit recovery with a registered hash: %s, without relying on a cached version query', async registered => {
  const current = { object, relativePath: "sample.txt", name: "sample.txt", versionNumber: 2, contentHash: registered ? "hash2" : null, state: "ambiguous" as const, reason: "旧版导入文件尚未记录文件身份，请确认当前位置后打开。" };
  const recoveredVersion = registered ? 2 : 3;
  vi.mocked(projectFileApi.resolve).mockResolvedValue(current);
  vi.mocked(projectFileApi.reconcile).mockImplementation(async () => {
    const ready = { ...current, versionNumber: recoveredVersion, contentHash: `hash${recoveredVersion}`, state: "ready" as const, reason: null };
    vi.mocked(projectFileApi.resolve).mockResolvedValue(ready);
    vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: recoveredVersion, currentContentHash: ready.contentHash, versions: [version(recoveredVersion), version(1)], nextCursor: null });
    return ready;
  });
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ProjectFileContent {...input} identityRecovery={onRecovered =>
    <ProjectFileIdentityActions {...input} initialOpen onRecovered={onRecovered} />
  } /></QueryClientProvider>);
  await screen.findByText("旧版导入文件尚未记录文件身份，请确认当前位置后打开。", { selector: '[role="alert"]' });
  expect(projectFileApi.readBytes).not.toHaveBeenCalled();
  expect(client.getQueryCache().find({ queryKey: ["documentVersions", 7] })).toBeUndefined();
  if (!registered) fireEvent.click(await screen.findByRole("checkbox", { name: /旧版本仍保留为未经核验/ }));
  const submit = await screen.findByRole("button", { name: registered ? "确认同一文件的新位置" : "确认并登记当前文件" });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  await screen.findByText(`version${recoveredVersion}`);
  expect(projectFileApi.reconcile).toHaveBeenCalledWith(binding, object, "sample.txt", 2, current.contentHash, registered ? "location" : "registration");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "文件位置核对" })).not.toBeInTheDocument();
});
// Use the registered content-tab guard with the real Office component/session:
// Project/window leave also invokes this same guard through the layout registrar.
async function editedOffice(format: 'docx' | 'xlsx' = 'docx', moveState?: { committed: boolean; nativeSessionsClosed?: boolean }) {
  vi.mocked(projectFileApi.resolve).mockResolvedValue({object,name:`sample.${format}`,relativePath:`sample.${format}`,versionNumber:2,contentHash:'hash2',state:'ready',reason:null});
  vi.mocked(fileWorkingApi.open).mockResolvedValue({...workingStatus(),sessionId:'session',name:`sample.${format}`,base64:'UEs=',format,model:{format,nodes:[{id:'p0',text:'原文'}]}} as never);
  const versions = [2, 1].map(n => ({ ...version(n), name: `sample.${format}` }));
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: 2, currentContentHash: "hash2", versions, nextCursor: null });
  vi.mocked(officeFileApi.inspect).mockResolvedValue({ model: { format, nodes: [{ id: "p0", text: "原文" }] } } as never);
  let guard!: () => Promise<void>;
  const registerCloseGuard = (next: () => Promise<void>) => { guard = next; return () => {}; };
  const rendered = view({ ...input, registerCloseGuard } as typeof input, moveState);
  const edit = await screen.findByRole("button", { name: "编辑", exact: true });
  await waitFor(() => expect(edit).not.toBeDisabled());
  fireEvent.click(edit);
  const editor = await screen.findByRole("textbox", { name: "Office 正文" });
  await waitFor(() => expect(editor).not.toBeDisabled());
  fireEvent.change(editor, { target: { value: "未保存草稿" } });
  return { ...rendered, editor, close: () => guard(), hide: () => rendered.rerender(rendered.wrap({ ...input, visible: false, registerCloseGuard } as typeof input)) };
}
it.each([true, false])('releases the old File session only when the confirmed move has not ended it natively (%s)', async nativeSessionsClosed => {
  const moved = { committed: false, nativeSessionsClosed: false };
  const rendered = await editedOffice('docx', moved);
  vi.mocked(fileWorkingApi.close).mockClear(); vi.mocked(fileWorkingApi.saveOffice).mockClear();
  moved.committed = true; moved.nativeSessionsClosed = nativeSessionsClosed;
  rendered.unmount();
  await act(async () => { await Promise.resolve(); });
  if (nativeSessionsClosed) expect(fileWorkingApi.close).not.toHaveBeenCalled();
  else expect(fileWorkingApi.close).toHaveBeenCalledWith(binding, { object, sessionId: "session" });
  expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
});
async function requestFileFlush(override: Partial<{object: typeof object; binding: typeof binding}> = {}) {
  await waitFor(() => expect(fileEditorApi.register).toHaveBeenCalled());
  const registration = vi.mocked(fileEditorApi.register).mock.calls.at(-1)!;
  const listener = vi.mocked(desktopApi.listenEvent).mock.calls.filter(([event]) => event === 'file:editor-flush-request').at(-1)![1];
  const request={binding:registration[0],object:registration[1],editorId:registration[2],flushId:'flush-1',operationId:crypto.randomUUID(),...override};
  act(() => listener(request));
  return request;
}
async function sendFileReplaced(operationId: string, overrides = {}) {
  const listener=vi.mocked(desktopApi.listenEvent).mock.calls.find(([event])=>event==='content:file-replaced')?.[1];
  expect(listener).toBeTypeOf('function');
  await act(async()=>listener!({binding,operationId,object,versionNumber:3,contentHash:'replacement-hash',noChange:false,oldSessionsClosed:true,...overrides}));
}
async function replacementOfficeTab() {
  vi.mocked(projectFileApi.resolve).mockResolvedValue({object,name:'sample.docx',relativePath:'sample.docx',versionNumber:2,contentHash:'hash2',state:'ready',reason:null});
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object,currentVersionNumber:2,currentContentHash:'hash2',versions:[{...version(2),name:'sample.docx'}],nextCursor:null});
  vi.mocked(fileWorkingApi.open).mockResolvedValue({...workingStatus(),sessionId:'old-session',name:'sample.docx',base64:'UEs=',format:'docx',model:{format:'docx',nodes:[{id:'p0',text:'原文'}]}} as never);
  vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue({...workingStatus(),revision:3,contentHash:'saved-before-replace'});
  const onClose=vi.fn(async()=>undefined), onSourceReady=vi.fn(), onReleased=vi.fn();
  const tab={id:'replaced-file-tab',object:{kind:'file' as const,id:7,title:'目标文件.docx'},view:{}};
  const rendered=render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
    <ProjectContentLayoutView scope={{workspaceId:binding.workspaceId,projectId:2}} active
      layout={{tabs:[tab],panes:[{id:'left',tabIds:[tab.id],selectedTabId:tab.id}],focusedPaneId:'left',ratio:0.5}}
      onOverview={()=>undefined} onSelect={()=>undefined} onClose={onClose}
      registerLeaveGuard={(prepare,lockObject,moved)=>registerProjectContentCloseGuard({workspaceRoot:'/replaced-file',projectId:2,binding,prepare,
        lockObject:target=>{const unlock=lockObject(target);return()=>{onReleased();unlock();};},moved})}
      renderPage={props=><ProjectFileContent {...input} onSourceReady={onSourceReady} registerCloseGuard={props.registerCloseGuard}/>} />
  </QueryClientProvider>);
  const edit=await screen.findByRole('button',{name:'编辑',exact:true});
  await waitFor(()=>expect(edit).toBeEnabled());fireEvent.click(edit);
  const oldEditor=await screen.findByRole('textbox',{name:'Office 正文'});
  fireEvent.change(oldEditor,{target:{value:'保存后替换'}});
  return {...rendered,oldEditor,onClose,onSourceReady,onReleased};
}
it('reloads a replaced File in the same Tab, releases only after retiring its old renderer, and closes the new session normally', async () => {
  const rendered=await replacementOfficeTab();
  const {oldEditor,onClose,onSourceReady,onReleased}=rendered;
  const request=await requestFileFlush();
  await waitFor(()=>expect(fileEditorApi.reply).toHaveBeenCalledWith(binding,expect.objectContaining({outcome:'saved'})));
  const page=oldEditor.closest('[role="tabpanel"]')!;
  expect(page).toHaveAttribute('inert');
  onReleased.mockImplementation(()=>expect(oldEditor).not.toBeInTheDocument());
  vi.mocked(fileWorkingApi.saveOffice).mockClear();vi.mocked(fileWorkingApi.close).mockClear();onSourceReady.mockClear();
  vi.mocked(projectFileApi.resolve).mockResolvedValue({object,name:'sample.docx',relativePath:'sample.docx',versionNumber:3,contentHash:'replacement-hash',state:'ready',reason:null});
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object,currentVersionNumber:3,currentContentHash:'replacement-hash',versions:[{...version(3),name:'sample.docx',contentHash:'replacement-hash'}],nextCursor:null});
  vi.mocked(fileWorkingApi.open).mockResolvedValue({...workingStatus(),revision:4,contentHash:'replacement-hash',archivedVersionNumber:3,sessionId:'new-session',name:'sample.docx',base64:'UEs=',format:'docx',model:{format:'docx',nodes:[{id:'p0',text:'替换后的正文'}]}} as never);
  await sendFileReplaced(request.operationId);
  expect(await screen.findByDisplayValue('替换后的正文')).not.toBe(oldEditor);
  expect(page).not.toHaveAttribute('inert');expect(onReleased).toHaveBeenCalledOnce();
  expect(onSourceReady).toHaveBeenCalledWith(null);
  expect(screen.getByRole('tab',{name:'目标文件.docx'})).toBeInTheDocument();expect(onClose).not.toHaveBeenCalled();
  expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(fileWorkingApi.close).not.toHaveBeenCalled();
  rendered.unmount();
  expect(fileWorkingApi.close).toHaveBeenCalledExactlyOnceWith(binding,{object,sessionId:'new-session'});
});
it('keeps the original File renderer and draft when a prepared replacement is released without committing', async () => {
  const rendered=await replacementOfficeTab();
  const request=await requestFileFlush();
  await waitFor(()=>expect(fileEditorApi.reply).toHaveBeenCalledWith(binding,expect.objectContaining({outcome:'saved'})));
  const page=rendered.oldEditor.closest('[role="tabpanel"]')!;
  expect(page).toHaveAttribute('inert');
  vi.mocked(fileWorkingApi.saveOffice).mockClear();vi.mocked(fileWorkingApi.close).mockClear();vi.mocked(fileWorkingApi.open).mockClear();
  await act(async()=>releaseContentOwnerMove({binding,operationId:request.operationId,source:object}));
  expect(page).not.toHaveAttribute('inert');
  expect(screen.getByLabelText('Office 正文')).toBe(rendered.oldEditor);
  expect(rendered.oldEditor).toHaveValue('保存后替换');
  expect(fileWorkingApi.open).not.toHaveBeenCalled();expect(fileWorkingApi.close).not.toHaveBeenCalled();expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
  expect(rendered.onClose).not.toHaveBeenCalled();
  rendered.unmount();
  expect(fileWorkingApi.close).toHaveBeenCalledExactlyOnceWith(binding,{object,sessionId:'old-session'});
});
it.each([
  {noChange:false,oldSessionsClosed:false}, {noChange:false,oldSessionsClosed:true},
  {noChange:true,oldSessionsClosed:true},
])('retires replacement sessions according to oldSessionsClosed independently of noChange: %j', async flags => {
  const rendered=await editedOffice();
  vi.mocked(fileWorkingApi.open).mockResolvedValue({...workingStatus(),sessionId:'new-session',name:'sample.docx',base64:'UEs=',format:'docx',model:{format:'docx',nodes:[{id:'p0',text:'终局后的正文'}]}} as never);
  vi.mocked(fileWorkingApi.close).mockClear();vi.mocked(fileWorkingApi.saveOffice).mockClear();
  const operationId=crypto.randomUUID();
  await sendFileReplaced(operationId,flags);
  const newEditor=await screen.findByDisplayValue('终局后的正文');
  expect(newEditor).not.toBe(rendered.editor);
  expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
  if(flags.oldSessionsClosed)expect(fileWorkingApi.close).not.toHaveBeenCalled();
  else expect(fileWorkingApi.close).toHaveBeenCalledExactlyOnceWith(binding,{object,sessionId:'session'});
  fireEvent.click(screen.getByRole('button',{name:'编辑',exact:true}));
  fireEvent.change(newEditor,{target:{value:'终局之后的新草稿'}});
  await sendFileReplaced(operationId,flags);
  expect(screen.getByDisplayValue('终局之后的新草稿')).toBe(newEditor);
  expect(fileWorkingApi.open).toHaveBeenCalledTimes(2);
  rendered.unmount();
  expect(fileWorkingApi.close).toHaveBeenLastCalledWith(binding,{object,sessionId:'new-session'});
  expect(fileWorkingApi.close).toHaveBeenCalledTimes(flags.oldSessionsClosed?1:2);
});
it('retains the noChange editor/session, acknowledges its native archive, and ignores duplicate terminals after new edits', async () => {
  const rendered=await replacementOfficeTab();
  vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue({...workingStatus(),revision:3,contentHash:'saved-before-replace',pendingArchive:true});
  const request=await requestFileFlush();
  await waitFor(()=>expect(fileEditorApi.reply).toHaveBeenCalledWith(binding,expect.objectContaining({outcome:'saved'})));
  const page=rendered.oldEditor.closest('[role="tabpanel"]')!;
  expect(page).toHaveAttribute('inert');
  vi.mocked(fileWorkingApi.tick).mockResolvedValue({...workingStatus(),revision:3,contentHash:'saved-before-replace',archivedVersionNumber:3,pendingArchive:false});
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object,currentVersionNumber:3,currentContentHash:'saved-before-replace',versions:[{...version(3),name:'sample.docx',contentHash:'saved-before-replace'}],nextCursor:null});
  vi.mocked(fileWorkingApi.open).mockClear();vi.mocked(fileWorkingApi.close).mockClear();vi.mocked(fileWorkingApi.saveOffice).mockClear();rendered.onSourceReady.mockClear();
  const flags={noChange:true,oldSessionsClosed:false,contentHash:'saved-before-replace'};
  await sendFileReplaced(request.operationId,flags);
  await waitFor(()=>expect(rendered.onSourceReady).toHaveBeenCalledWith(expect.objectContaining({fileVersion:3,revision:'saved-before-replace'})));
  expect(screen.getByLabelText('Office 正文')).toBe(rendered.oldEditor);
  expect(rendered.oldEditor).toHaveValue('保存后替换');expect(page).not.toHaveAttribute('inert');
  expect(fileWorkingApi.tick).toHaveBeenCalledWith(binding,object);
  expect(fileWorkingApi.open).not.toHaveBeenCalled();expect(fileWorkingApi.close).not.toHaveBeenCalled();expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
  fireEvent.change(rendered.oldEditor,{target:{value:'noChange之后的新草稿'}});
  vi.mocked(fileWorkingApi.tick).mockClear();vi.mocked(fileDocumentApi.versionsList).mockClear();
  await sendFileReplaced(request.operationId,flags);
  expect(screen.getByDisplayValue('noChange之后的新草稿')).toBe(rendered.oldEditor);
  expect(fileWorkingApi.tick).not.toHaveBeenCalled();expect(fileDocumentApi.versionsList).not.toHaveBeenCalled();
  expect(rendered.onClose).not.toHaveBeenCalled();
  rendered.unmount();expect(fileWorkingApi.close).toHaveBeenCalledExactlyOnceWith(binding,{object,sessionId:'old-session'});
});
it('retires a hidden current renderer immediately and loads replacement working content only after showing it', async () => {
  const rendered=await editedOffice();rendered.hide();
  vi.mocked(fileWorkingApi.open).mockClear();vi.mocked(fileWorkingApi.saveOffice).mockClear();vi.mocked(fileWorkingApi.close).mockClear();
  await sendFileReplaced(crypto.randomUUID());
  expect(rendered.editor).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Office 正文')).toBeNull();
  expect(fileWorkingApi.open).not.toHaveBeenCalled();expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(fileWorkingApi.close).not.toHaveBeenCalled();
  vi.mocked(fileWorkingApi.open).mockResolvedValue({...workingStatus(),sessionId:'visible-session',name:'sample.docx',base64:'UEs=',format:'docx',model:{format:'docx',nodes:[{id:'p0',text:'再次显示的新正文'}]}} as never);
  rendered.rerender(rendered.wrap(input));
  expect(await screen.findByDisplayValue('再次显示的新正文')).toBeInTheDocument();
  rendered.unmount();
  expect(fileWorkingApi.close).toHaveBeenCalledExactlyOnceWith(binding,{object,sessionId:'visible-session'});
});
it('allows a same-File native flush after a hidden replacement without reviving or saving its retired editor', async () => {
  const rendered=await editedOffice();rendered.hide();
  const operationId=crypto.randomUUID();
  await sendFileReplaced(operationId);
  expect(rendered.editor).not.toBeInTheDocument();
  vi.mocked(fileEditorApi.reply).mockClear();vi.mocked(fileWorkingApi.saveOffice).mockClear();vi.mocked(fileWorkingApi.close).mockClear();vi.mocked(fileWorkingApi.open).mockClear();
  await requestFileFlush({binding:{...binding,generation:'foreign'}});
  expect(fileEditorApi.reply).not.toHaveBeenCalled();
  await sendFileReplaced(operationId);
  await requestFileFlush();
  await waitFor(()=>expect(fileEditorApi.reply).toHaveBeenCalledWith(binding,expect.objectContaining({outcome:'saved'})));
  expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(fileWorkingApi.open).not.toHaveBeenCalled();expect(fileWorkingApi.close).not.toHaveBeenCalled();
  rendered.unmount();
});
it.each(['kind','owner','generation','workspace','id'] as const)('ignores replacement terminal events with a foreign %s', async foreign => {
  const rendered=await editedOffice();
  const otherObject={...object,scope:{...object.scope}};
  const otherBinding={...binding};
  const event: Record<string,unknown>={object:otherObject,binding:otherBinding};
  if(foreign==='kind')event.object={...otherObject,kind:'record'};
  if(foreign==='owner')otherObject.scope.projectId=99;
  if(foreign==='generation')otherBinding.generation='reopened';
  if(foreign==='workspace')otherBinding.workspaceId='another';
  if(foreign==='id')otherObject.id='99';
  vi.mocked(fileWorkingApi.open).mockClear();vi.mocked(fileWorkingApi.close).mockClear();vi.mocked(fileWorkingApi.saveOffice).mockClear();
  await sendFileReplaced(crypto.randomUUID(),event);
  expect(rendered.editor).toBeInTheDocument();expect(rendered.editor).toHaveValue('未保存草稿');
  expect(fileWorkingApi.open).not.toHaveBeenCalled();expect(fileWorkingApi.close).not.toHaveBeenCalled();expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
});
it('keeps the selected immutable history renderer after replacement and only refreshes version metadata', async () => {
  const rendered=await editedOffice();
  vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue({...workingStatus(),revision:3,contentHash:'saved'});
  await chooseVersion(1);
  await screen.findByLabelText('Office 正文');
  await waitFor(()=>expect(officeFileApi.inspect).toHaveBeenCalled());
  const historical=screen.getByLabelText('Office 正文');
  const sourceReadCount=vi.mocked(officeFileApi.inspect).mock.calls.length;
  vi.mocked(fileWorkingApi.close).mockClear();vi.mocked(fileWorkingApi.saveOffice).mockClear();vi.mocked(fileWorkingApi.open).mockClear();
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object,currentVersionNumber:3,currentContentHash:'replacement-hash',versions:[{...version(3),name:'sample.docx',contentHash:'replacement-hash'},{...version(1),name:'sample.docx',displayName:'保留历史',isImportant:true,metadataRevision:1}],nextCursor:null});
  await sendFileReplaced(crypto.randomUUID());
  expect(screen.getByLabelText('Office 正文')).toBe(historical);
  expect(officeFileApi.inspect).toHaveBeenCalledTimes(sourceReadCount);
  expect(fileWorkingApi.open).not.toHaveBeenCalled();expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(fileWorkingApi.close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'文件查看版本'}));
  expect(screen.getByRole('menuitemradio',{name:/v1/})).toHaveAttribute('aria-checked','true');
  expect(screen.getByRole('menuitemradio',{name:/v3/})).toBeInTheDocument();
  rendered.unmount();
});
it('registers a File editor with the frozen native lowercase 32-hex identity', async () => {
  view();
  await waitFor(() => expect(fileEditorApi.register).toHaveBeenCalledOnce());
  expect(fileEditorApi.register).toHaveBeenCalledWith(binding, object, expect.stringMatching(/^[0-9a-f]{32}$/u));
});
it('waits for the replacement terminal listener before registering the File editor', async () => {
  let subscribe!: (stop: () => void) => void;
  vi.mocked(desktopApi.listenEvent).mockReturnValueOnce(new Promise(resolve=>{subscribe=resolve;}));
  view();
  await waitFor(()=>expect(desktopApi.listenEvent).toHaveBeenCalledWith('content:file-replaced',expect.any(Function)));
  expect(fileEditorApi.register).not.toHaveBeenCalled();
  await act(async()=>subscribe(()=>undefined));
  await waitFor(()=>expect(fileEditorApi.register).toHaveBeenCalledOnce());
});
it('captures an active File cell on its native save event and retains registration while hidden', async () => {
  vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue({...workingStatus(),revision:3,contentHash:'saved-cell'});
  const rendered = await editedOffice('xlsx');
  rendered.hide();
  await requestFileFlush({object:{...object,id:'99'}});
  expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
  expect(fileEditorApi.reply).not.toHaveBeenCalled();
  await requestFileFlush();
  await waitFor(()=>expect(fileEditorApi.reply).toHaveBeenCalledWith(binding,expect.objectContaining({object,flushId:'flush-1',outcome:'saved'})));
  expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding,expect.objectContaining({edits:[expect.objectContaining({value:'未保存草稿'})]}),expect.any(String));
  expect(fileEditorApi.register).toHaveBeenCalledOnce();
  expect(fileEditorApi.unregister).not.toHaveBeenCalled();
  rendered.unmount();
  expect(fileEditorApi.unregister).toHaveBeenCalledWith(binding,object,expect.any(String));
});
it('replies failed to a File save event without confirming discard when the native save fails', async () => {
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new AgentApiError({code:'OBJECT_WITHDRAWN',message:'File withdrawn',retryable:false}));
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  const rendered = await editedOffice('xlsx');
  await requestFileFlush();
  await waitFor(()=>expect(fileEditorApi.reply).toHaveBeenCalledWith(binding,expect.objectContaining({outcome:'failed'})));
  expect(desktopApi.confirm).not.toHaveBeenCalled();
  expect(rendered.editor).toHaveValue('未保存草稿');
  expect(fileWorkingApi.close).not.toHaveBeenCalled();
});
it('registers a readonly File early but cannot acknowledge saved until its loaded editor is ready', async () => {
  let resolveVersions!: (value: Awaited<ReturnType<typeof fileDocumentApi.versionsList>>) => void;
  vi.mocked(fileDocumentApi.versionsList).mockReturnValueOnce(new Promise(resolve => { resolveVersions = resolve; }));
  let resolveInspect!: (value: Awaited<ReturnType<typeof officeFileApi.inspect>>) => void;
  vi.mocked(officeFileApi.inspect).mockReturnValueOnce(new Promise(resolve => { resolveInspect = resolve; }));
  view({...input,versionNumber:1} as typeof input);
  await requestFileFlush();
  await waitFor(()=>expect(fileEditorApi.reply).toHaveBeenCalledWith(binding,expect.objectContaining({outcome:'busy'})));
  vi.mocked(fileEditorApi.reply).mockClear();
  await act(async()=>resolveVersions({object,currentVersionNumber:2,currentContentHash:'hash2',versions:[{...version(1),name:'sample.docx'}],nextCursor:null}));
  await waitFor(()=>expect(officeFileApi.inspect).toHaveBeenCalled());
  await requestFileFlush();
  await waitFor(()=>expect(fileEditorApi.reply).toHaveBeenCalledWith(binding,expect.objectContaining({outcome:'busy'})));
  vi.mocked(fileEditorApi.reply).mockClear();
  await act(async()=>resolveInspect({model:{format:'docx',nodes:[{id:'p0',text:'历史正文'}]}} as Awaited<ReturnType<typeof officeFileApi.inspect>>));
  await screen.findByLabelText('Office 正文');
  await requestFileFlush();
  await waitFor(()=>expect(fileEditorApi.reply).toHaveBeenCalledWith(binding,expect.objectContaining({outcome:'saved'})));
  expect(fileEditorApi.register).toHaveBeenCalledOnce();
  expect(fileWorkingApi.open).not.toHaveBeenCalled();
  expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
});
it('unregisters a late File registration after its page was disposed', async () => {
  let finish!: (value: null) => void;
  vi.mocked(fileEditorApi.register).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  const unlisten=vi.fn(); vi.mocked(desktopApi.listenEvent).mockResolvedValueOnce(unlisten);
  const rendered=view();
  await waitFor(()=>expect(fileEditorApi.register).toHaveBeenCalledOnce());
  const [, , editorId]=vi.mocked(fileEditorApi.register).mock.calls[0];
  rendered.unmount();
  await act(async()=>finish(null));
  expect(fileEditorApi.unregister).toHaveBeenCalledExactlyOnceWith(binding,object,editorId);
  expect(unlisten).toHaveBeenCalledOnce();
});
it.each(['root','owner','id','binding'] as const)('disposes the old File registration when its %s identity changes', async change => {
  const rendered=view();
  await waitFor(()=>expect(fileEditorApi.register).toHaveBeenCalledOnce());
  const [oldBinding,oldObject,oldEditorId]=vi.mocked(fileEditorApi.register).mock.calls[0];
  const oldListener=vi.mocked(desktopApi.listenEvent).mock.calls.find(([event])=>event==='file:editor-flush-request')![1];
  const next={...input};
  if(change==='root')next.workspaceRoot='/other';
  if(change==='owner')next.projectId=3;
  if(change==='id')next.fileId=8;
  if(change==='binding'){
    vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({...binding,generation:'reopened'});
    fireEvent.click(screen.getByRole('button',{name:'刷新',exact:true}));
  }else rendered.rerender(rendered.wrap(next));
  await waitFor(()=>expect(fileEditorApi.register).toHaveBeenCalledTimes(2));
  expect(fileEditorApi.unregister).toHaveBeenCalledWith(oldBinding,oldObject,oldEditorId);
  act(()=>oldListener({binding:oldBinding,object:oldObject,editorId:oldEditorId,flushId:'stale',operationId:crypto.randomUUID()}));
  expect(fileEditorApi.reply).not.toHaveBeenCalled();
  expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();
});
it('shows a diagnostic when File move registration fails', async () => {
  vi.mocked(fileEditorApi.register).mockRejectedValueOnce(new Error('native registry unavailable'));
  view();
  expect(await screen.findByRole('alert')).toHaveTextContent('无法注册文件移动保存屏障：native registry unavailable');
  expect(fileEditorApi.unregister).not.toHaveBeenCalled();
});
it('allows the real hidden Office close guard after confirming a deleted managed File', async () => {
  const failure = new AgentApiError({ code: 'NOT_FOUND', message: 'File is no longer present', retryable: false });
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(failure);
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  const rendered = await editedOffice();
  rendered.hide();
  vi.mocked(fileDocumentApi.versionsList).mockRejectedValue(failure);
  await act(async () => { await expect(rendered.close()).resolves.toBeUndefined(); });
  expect(desktopApi.confirm).toHaveBeenCalledWith('原始文件已删除/不可用，关闭会丢失未保存修改');
  expect(rendered.editor).toHaveValue('未保存草稿');
  expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();
});
it.each(['NOT_FOUND', 'OBJECT_WITHDRAWN', 'SOURCE_NOT_READY'] as const)('keeps the File draft and never confirms discard or moves on strict save failure %s', async code => {
  const failure = new AgentApiError({ code, message: 'File cannot be saved', details: { reason: 'original_missing' }, retryable: false });
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(failure);
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  vi.mocked(projectFileApi.resolve).mockResolvedValue({object,name:'sample.docx',relativePath:'sample.docx',versionNumber:2,contentHash:'hash2',state:'ready',reason:null});
  vi.mocked(fileWorkingApi.open).mockResolvedValue({...workingStatus(),sessionId:'session',name:'sample.docx',base64:'UEs=',format:'docx',model:{format:'docx',nodes:[{id:'p0',text:'原文'}]}} as never);
  const tab = { id: 'moving-file', object: { kind: 'file' as const, id: 7, title: '目标文件.docx' }, view: {} };
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}>
    <ProjectContentLayoutView scope={{workspaceId:binding.workspaceId,projectId:2}} active
      layout={{tabs:[tab],panes:[{id:'left',tabIds:[tab.id],selectedTabId:tab.id}],focusedPaneId:'left',ratio:0.5}}
      onOverview={()=>undefined} onSelect={()=>undefined} onClose={async()=>undefined}
      registerLeaveGuard={(prepare,lockObject,moved)=>registerProjectContentCloseGuard({workspaceRoot:'/strict-file-page',projectId:2,prepare,lockObject,moved})}
      renderPage={props=><ProjectFileContent {...input} registerCloseGuard={props.registerCloseGuard}/>} />
  </QueryClientProvider>);
  const edit = await screen.findByRole('button',{name:'编辑',exact:true});
  await waitFor(()=>expect(edit).toBeEnabled()); fireEvent.click(edit);
  const editor = await screen.findByLabelText('Office 正文');
  fireEvent.change(editor,{target:{value:'必须保留的文件草稿'}});
  vi.mocked(fileDocumentApi.versionsList).mockRejectedValue(failure);
  const move = vi.fn(async()=>undefined);
  await act(async()=>{await expect(withProjectContentMove('/strict-file-page',2,{kind:'file',id:7},move)).rejects.toThrow('File cannot be saved');});
  expect(move).not.toHaveBeenCalled(); expect(desktopApi.confirm).not.toHaveBeenCalled();
  expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();
  expect(editor).toHaveValue('必须保留的文件草稿');
  expect(screen.getByRole('tab',{name:'目标文件.docx'})).toBeInTheDocument();
});
it('confirms closing after the native original_missing error from a deleted disk original', async () => {
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new AgentApiError({ code: 'SOURCE_NOT_READY', message: 'Original File is missing', details: { reason: 'original_missing' }, retryable: false }));
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  const rendered = await editedOffice();
  await act(() => rendered.close());
  expect(desktopApi.confirm).toHaveBeenCalledOnce();
  expect(rendered.editor).toHaveValue('未保存草稿');
});
it('does not treat a missing internal Office reference or version as a missing target File', async () => {
  const failure = new AgentApiError({ code: 'NOT_FOUND', message: 'Internal reference is no longer present', retryable: false });
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(failure);
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  const rendered = await editedOffice();
  await act(async () => { await expect(rendered.close()).rejects.toBe(failure); });
  expect(desktopApi.confirm).not.toHaveBeenCalled();
});
it.each([null, { workspaceId: 'another-workspace', generation: 'g' }, { workspaceId: 'w', generation: 'reopened' }])('rejects Office close consent when the active binding changes to %j', async current => {
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new AgentApiError({ code: 'SOURCE_NOT_READY', message: 'Original File is missing', details: { reason: 'original_missing' }, retryable: false }));
  vi.mocked(desktopApi.confirm).mockImplementation(async () => {
    vi.mocked(agentApi.statusGet).mockResolvedValue({ binding: current } as Awaited<ReturnType<typeof agentApi.statusGet>>);
    return true;
  });
  const rendered = await editedOffice();
  await act(async () => { await expect(rendered.close()).rejects.toThrow('工作区已切换'); });
  expect(desktopApi.confirm).toHaveBeenCalledOnce();
  expect(rendered.editor).toHaveValue('未保存草稿');
});
it('rechecks generation when a later leave guard reuses previous Office close consent', async () => {
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(originalMissing());
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  const rendered = await editedOffice();
  await act(() => rendered.close());
  vi.mocked(agentApi.statusGet).mockResolvedValue({ binding: { ...binding, generation: 'reopened' } } as Awaited<ReturnType<typeof agentApi.statusGet>>);
  await act(async () => { await expect(rendered.close()).rejects.toThrow('工作区已切换'); });
  expect(desktopApi.confirm).toHaveBeenCalledOnce();
  expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();
});
it.each<AgentError>([
  { code: 'IO_FAILED', message: 'Cannot read retained File versions', retryable: false },
  { code: 'SCOPE_DENIED', message: 'File belongs to another owner', retryable: false },
  { code: 'WORKSPACE_CHANGED', message: 'File Workspace is no longer current', retryable: false },
])('propagates target absence lookup failures without offering discard: $code', async error => {
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new AgentApiError({ code: 'NOT_FOUND', message: 'Internal reference missing', retryable: false }));
  const rendered = await editedOffice();
  const failure = new AgentApiError(error);
  vi.mocked(fileDocumentApi.versionsList).mockRejectedValue(failure);
  await act(async () => { await expect(rendered.close()).rejects.toBe(failure); });
  expect(desktopApi.confirm).not.toHaveBeenCalled();
});
it('reuses close consent for repeated leave guards, but asks again after a new Office edit', async () => {
  const failure = originalMissing();
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(failure);
  vi.mocked(desktopApi.confirm).mockResolvedValueOnce(true).mockResolvedValue(false);
  const rendered = await editedOffice();
  await act(() => rendered.close());
  await act(() => rendered.close());
  expect(desktopApi.confirm).toHaveBeenCalledOnce();
  expect(fileWorkingApi.saveOffice).toHaveBeenCalledOnce();
  fireEvent.change(rendered.editor, { target: { value: '新的未保存修改' } });
  await act(async () => { await expect(rendered.close()).rejects.toBe(failure); });
  expect(desktopApi.confirm).toHaveBeenCalledTimes(2);
  expect(rendered.editor).toHaveValue('新的未保存修改');
});
it('shares an outstanding Office close confirmation and rejects consent if editing continues', async () => {
  const failure = originalMissing();
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(failure);
  let answer!: (accepted: boolean) => void;
  vi.mocked(desktopApi.confirm).mockImplementation(() => new Promise(resolve => { answer = resolve; }));
  const rendered = await editedOffice();
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => {
    first = rendered.close();
    second = rendered.close();
  });
  expect(desktopApi.confirm).toHaveBeenCalledOnce();
  fireEvent.change(rendered.editor, { target: { value: '确认期间的新修改' } });
  await act(async () => {
    const rejected = Promise.all([expect(first).rejects.toBe(failure), expect(second).rejects.toBe(failure)]);
    answer(true);
    await rejected;
  });
  vi.mocked(desktopApi.confirm).mockResolvedValue(false);
  await act(async () => { await expect(rendered.close()).rejects.toBe(failure); });
  expect(desktopApi.confirm).toHaveBeenCalledTimes(2);
  expect(rendered.editor).toHaveValue('确认期间的新修改');
});
it.each<AgentError>([
  { code: 'OBJECT_WITHDRAWN', message: 'File has been withdrawn; restore it to use its current contents', retryable: false },
  { code: 'SOURCE_NOT_READY', message: 'Original File is missing', details: { reason: 'original_missing' }, retryable: false },
])('allows closing only after confirming explicit Office source unavailability: $code', async error => {
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new AgentApiError(error));
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  const rendered = await editedOffice();
  await act(() => rendered.close());
  expect(desktopApi.confirm).toHaveBeenCalledOnce();
  expect(rendered.editor).toHaveValue('未保存草稿');
});
it('keeps the Office draft after declining close and permits a later confirmed retry', async () => {
  const failure = originalMissing();
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(failure);
  const rendered = await editedOffice();
  await act(async () => { await expect(rendered.close()).rejects.toBe(failure); });
  expect(rendered.editor).toHaveValue('未保存草稿');
  expect(screen.getByRole('status')).toHaveTextContent('保存失败');
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  await act(() => rendered.close());
  expect(desktopApi.confirm).toHaveBeenCalledTimes(2);
});
it('invalidates close consent for spreadsheet input before the cell enters the edit journal', async () => {
  const failure = originalMissing();
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(failure);
  vi.mocked(desktopApi.confirm).mockResolvedValueOnce(true).mockResolvedValue(false);
  const rendered = await editedOffice('xlsx');
  await act(() => rendered.close());
  fireEvent.change(rendered.editor, { target: { value: '尚未按 Enter 的单元格' } });
  await act(async () => { await expect(rendered.close()).rejects.toBe(failure); });
  expect(desktopApi.confirm).toHaveBeenCalledTimes(2);
  expect(rendered.editor).toHaveValue('尚未按 Enter 的单元格');
  expect(fileWorkingApi.saveOffice).toHaveBeenLastCalledWith(binding, expect.objectContaining({ edits: [{ sheetId: 'sheet-1', row: 0, column: 0, kind: 'string', value: '未保存草稿' }] }), expect.any(String));
  // The failed attempt is replayed exactly before the later cell can be saved.
  expect(rendered.editor).toHaveValue('尚未按 Enter 的单元格');
});
it.each<AgentError>([
  // Generic I/O and retained version failures are not original-file absence.
  { code: 'IO_FAILED', message: 'Cannot prepare or commit File Version', retryable: false },
  { code: 'SCOPE_DENIED', message: 'File belongs to another owner', retryable: false },
  { code: 'REVISION_CONFLICT', message: 'Office File baseline hash changed', retryable: false },
  { code: 'FILE_CHANGED_UNREGISTERED', message: 'Office File changed on disk', retryable: false },
  { code: 'SOURCE_CHANGED', message: 'File changed during preflight', retryable: false },
  { code: 'SOURCE_NOT_READY', message: 'Historical File hash is unknown', details: { reason: 'version_unregistered' }, retryable: false },
  { code: 'SOURCE_NOT_READY', message: 'Retained File Version bytes are missing', details: { reason: 'snapshot_missing' }, retryable: false },
  { code: 'SOURCE_NOT_READY', message: 'missing', retryable: false },
  { code: 'WORKSPACE_CHANGED', message: 'File Workspace binding changed', retryable: false },
  { code: 'IDEMPOTENCY_CONFLICT', message: 'Request identity conflict', retryable: false },
])('never offers Office discard for ambiguous or unrelated failures: $code $message', async error => {
  const failure = new AgentApiError(error);
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(failure);
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  const rendered = await editedOffice();
  await act(async () => { await expect(rendered.close()).rejects.toBe(failure); });
  expect(desktopApi.confirm).not.toHaveBeenCalled();
  expect(rendered.editor).toHaveValue('未保存草稿');
});
it('does not classify unstructured Office errors by their missing-file message', async () => {
  const failure = new Error('原始文件已删除 / File not found');
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(failure);
  const rendered = await editedOffice();
  await act(async () => { await expect(rendered.close()).rejects.toBe(failure); });
  expect(desktopApi.confirm).not.toHaveBeenCalled();
});
it.each(['save', 'shortcut', 'refresh', 'version', 'external'])('close consent never authorizes ordinary Office %s', async action => {
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(originalMissing());
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  const rendered = await editedOffice();
  await act(() => rendered.close());
  if (action === 'save') fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
  else if (action === 'shortcut') fireEvent.keyDown(rendered.editor, { key: 's', metaKey: true });
  else if (action === 'refresh') fireEvent.click(screen.getByRole('button', { name: '刷新', exact: true }));
  else if (action === 'external') fireEvent.click(screen.getByRole('button', { name: '在外部应用打开当前原件' }));
  else await chooseVersion(1);
  await waitFor(() => expect(fileWorkingApi.saveOffice).toHaveBeenCalledTimes(2));
  expect(desktopApi.confirm).toHaveBeenCalledOnce();
  expect(rendered.editor).toHaveValue('未保存草稿');
  expect(screen.getByRole('button', { name: '文件查看版本' })).toHaveTextContent('当前内容');
  expect(fileWorkingApi.open).toHaveBeenCalledOnce();
  expect(projectFileApi.resolve).toHaveBeenCalledOnce();
  expect(projectFileApi.openLocal).not.toHaveBeenCalled();
});
it('previews without Session or model; latest and fixed version share the same File component', async () => {
  const change = vi.fn();
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><ProjectFileContent {...input} onViewChange={change} /></QueryClientProvider>);
  await screen.findByText('version2');
  expect(screen.getByRole('button', { name: '文件查看版本' }).textContent).toBe('v2');
  await chooseVersion(1);
  await screen.findByText('version1');
  expect(change).toHaveBeenCalledWith({ versionNumber: 1, sourceLocator: undefined, line: undefined, page: undefined });
  expect(screen.getAllByRole('region', { name: '项目文件预览' })).toHaveLength(1);
  expect(projectFileApi.readBytes).toHaveBeenLastCalledWith(binding, { object, versionNumber: 1, expectedContentHash: 'hash1' });
});
it('isolates late byte responses when changing versions', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }) as ReturnType<typeof projectFileApi.readBytes>);
  const rendered = view();
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({ ...input, versionNumber: 1 } as typeof input));
  await screen.findByText('version1');
  await act(async () => finish({ object, versionNumber: 2, contentHash: 'hash2', name: 'old.txt', mime: 'text/plain', byteLength: 8, base64: btoa('version2') }));
  expect(screen.queryByText('version2')).not.toBeInTheDocument();
});
it('checks every source page against the same version/hash and preserves complete Unicode text', async () => {
  const text = 'first\n第二行'; const whole = source(2, text);
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValueOnce({ ...whole, text: 'first\n', endChar: 6, nextCursor: 'next', complete: false })
    .mockResolvedValueOnce({ ...whole, text: '第二行', startChar: 6, nextCursor: null, complete: true });
  view({ ...input, line: 2 } as typeof input);
  await screen.findByText('第二行');
  expect(fileDocumentApi.sourceRead).toHaveBeenNthCalledWith(2, binding, { object, versionNumber: 2, expectedContentHash: 'hash2', cursor: 'next', budgetChars: 24000 });
});
it('rejects mixed version pagination instead of rendering partial content', async () => {
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue({ ...source(2), versionNumber: 1 });
  view();
  expect(await screen.findByRole('alert')).toHaveTextContent('分页不一致');
  expect(screen.queryByText('version2')).not.toBeInTheDocument();
});
it('reports the native bound generation rejection', async () => {
  vi.mocked(projectFileApi.readBytes).mockRejectedValue({ code: 'WORKSPACE_CHANGED', message: '工作区已切换' });
  view();
  expect(await screen.findByRole('alert')).toHaveTextContent('工作区已切换');
});
it('reports missing historical snapshot and never retries latest', async () => {
  vi.mocked(projectFileApi.readBytes).mockRejectedValue({ code: 'snapshot_missing', message: '历史原件不可用' });
  view({ ...input, versionNumber: 1 } as typeof input);
  expect(await screen.findByRole('alert')).toHaveTextContent('历史原件不可用');
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
  expect(projectFileApi.readBytes).toHaveBeenCalledWith(binding, { object, versionNumber: 1, expectedContentHash: 'hash1' });
});
it('does not read hidden tabs and aborts pending pagination on hiding', async () => {
  const rendered = view({ ...input, visible: false });
  expect(recordDocumentApi.bindingGet).not.toHaveBeenCalled();
  rendered.rerender(rendered.wrap(input));
  await screen.findByText('version2');
  rendered.rerender(rendered.wrap({ ...input, visible: false }));
  expect(screen.queryByText('version2')).not.toBeInTheDocument();
});
it('uses fixed HTML TextBody source with exact line location and no extra service reads', async () => {
  const html = '<button>unsafe</button>\n<script>window.attack=1</script>';
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.html', mime: 'text/html', byteLength: html.length, base64: btoa(html) });
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue(source(2, html, 'sample.html', 'html'));
  const rendered = view({ ...input, versionNumber: 2, line: 2 } as typeof input);
  await screen.findByLabelText('原生网页显示区域');
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledWith(binding, {object,versionNumber:2,expectedContentHash:'hash2'},true));
  expect(rendered.container.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '源码 / 行定位' }));
  const original = rendered.container.querySelector('[data-textpreview-target="2"]');
  expect(original).toHaveTextContent('<script>window.attack=1</script>');
  expect(fileDocumentApi.sourceRead).toHaveBeenCalledOnce();
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
  expect(fileDocumentApi.versionsList).toHaveBeenCalledOnce();
  expect(rendered.container.querySelector('iframe')).toBeNull();
});
it('keeps legacy Office unsupported and does not invoke text parsing', async () => {
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.doc', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byteLength: 2, base64: btoa('PK') });
  view();
  await screen.findByText(/此格式暂不支持应用内预览或编辑/);
  expect(fileDocumentApi.sourceRead).not.toHaveBeenCalled();
});
it('opens a system application from a historical File view using only the current File identity', async () => {
  vi.mocked(projectFileApi.applications).mockResolvedValue([{ id: "/Applications/Editor.app", name: "Editor", icon: "data:image/png;base64,iVBORw0KGgo=", isDefault: false }]);
  view({ ...input, versionNumber: 1 } as typeof input);
  await screen.findByText('version1');
  fireEvent.click(screen.getByRole('button', { name: '选择其他应用打开当前原件' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Editor' }));
  await waitFor(() => expect(projectFileApi.openWith).toHaveBeenCalledWith(binding, object, '/Applications/Editor.app'));
  expect(screen.getByText('version1')).toBeVisible();
  expect(projectFileApi.openLocal).not.toHaveBeenCalled();
});
it('retains reading position across hiding and restores it without taking focus', async () => {
  const rendered = view(); await screen.findByText('version2');
  const scroll = rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement;
  scroll.scrollTop = 73; fireEvent.scroll(scroll);
  rendered.rerender(rendered.wrap({ ...input, visible: false }));
  rendered.rerender(rendered.wrap(input));
  await screen.findByText('version2');
  expect((rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(73);
});
it('reloads committed invalidation in latest mode and keeps a historical view fixed', async () => {
  const rendered = view(); await screen.findByText('version2');
  // Native UI invalidations share documentVersions; seed its cache entry.
  rendered.client.setQueryData(['documentVersions', 7], {});
  vi.mocked(projectFileApi.readBytes).mockClear();
  vi.mocked(projectFileApi.resolve).mockResolvedValue({object,name:'sample.txt',relativePath:'sample.txt',versionNumber:3,contentHash:'hash3',state:'ready',reason:null});
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object,currentVersionNumber:3,currentContentHash:'hash3',versions:[version(3),version(2),version(1)],nextCursor:null});
  await act(async () => rendered.client.invalidateQueries({ queryKey: ['documentVersions', 7] }));
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledOnce());
  await screen.findByText('version3');
  await chooseVersion(1);
  await screen.findByText('version1');
  vi.mocked(projectFileApi.readBytes).mockClear();
  await act(async () => rendered.client.invalidateQueries({ queryKey: ['documentVersions', 7] }));
  expect(projectFileApi.readBytes).not.toHaveBeenCalled();
  expect(screen.getByText('version1')).toBeInTheDocument();
});
it.each(['current','hidden','history'] as const)('refreshes invalidated File metadata in %s without replacing its renderer, draft, or session', async mode => {
  const rendered=await editedOffice();
  if(mode==='history'){
    vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue({...workingStatus(),revision:3,contentHash:'saved'});
    await chooseVersion(1);await waitFor(()=>expect(officeFileApi.inspect).toHaveBeenCalled());
  }
  const editor=screen.getByLabelText('Office 正文');
  if(mode==='hidden')rendered.hide();
  rendered.client.setQueryData(['documentVersions',7],{});
  const versions=[2,1].map(n=>({...version(n),name:'sample.docx',displayName:`新名称${n}`,isImportant:true,metadataRevision:8,metadataTarget:{binding,object}}));
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object,currentVersionNumber:2,currentContentHash:'hash2',versions,nextCursor:null});
  vi.mocked(fileDocumentApi.versionsList).mockClear();vi.mocked(fileWorkingApi.saveOffice).mockClear();vi.mocked(fileWorkingApi.close).mockClear();vi.mocked(fileWorkingApi.open).mockClear();vi.mocked(officeFileApi.inspect).mockClear();
  await act(async()=>rendered.client.invalidateQueries({queryKey:['documentVersions',7]}));
  await waitFor(()=>expect(fileDocumentApi.versionsList).toHaveBeenCalled());
  if(mode==='hidden')rendered.rerender(rendered.wrap(input));
  expect(screen.getByLabelText('Office 正文')).toBe(editor);
  if(mode!=='history')expect(editor).toHaveValue('未保存草稿');
  fireEvent.click(screen.getByRole('button',{name:'文件查看版本'}));
  const selected=mode==='history'?1:2;
  const row=await screen.findByRole('menuitemradio',{name:`v${selected}（新名称${selected}），重要版本`});
  expect(row.querySelector('svg')).toHaveAttribute('fill','currentColor');
  if(mode==='history')expect(row).toHaveAttribute('aria-checked','true');
  else expect(screen.getByRole('menuitemradio',{name:'当前内容'})).toHaveAttribute('aria-checked','true');
  expect(fileWorkingApi.saveOffice).not.toHaveBeenCalled();expect(fileWorkingApi.close).not.toHaveBeenCalled();expect(fileWorkingApi.open).not.toHaveBeenCalled();expect(officeFileApi.inspect).not.toHaveBeenCalled();
  // The actual metadata dialog must receive the refreshed CAS revision too.
  vi.mocked(fileDocumentApi.versionMetadataUpdate).mockResolvedValue({object,versionId:String(selected),displayName:'再命名',isImportant:true,metadataRevision:9});
  fireEvent.click(screen.getByRole('menuitem',{name:`编辑 V${selected} 标记`}));
  fireEvent.change(await screen.findByRole('textbox',{name:'自定义版本名称'}),{target:{value:'再命名'}});
  fireEvent.click(within(screen.getByRole('dialog',{name:'编辑版本标记'})).getByRole('button',{name:'保存',exact:true}));
  await waitFor(()=>expect(fileDocumentApi.versionMetadataUpdate).toHaveBeenCalledWith(binding,expect.objectContaining({object,versionId:String(selected),expectedMetadataRevision:8})));
  if(mode!=='history'){
    vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue({...workingStatus(),revision:3,contentHash:'saved'});
    await act(()=>rendered.close());
    expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding,expect.objectContaining({sessionId:'session',expectedRevision:2,expectedContentHash:'hash2'}),expect.any(String));
  }
  rendered.unmount();
});
it.each(['renderer','owner','binding'] as const)('ignores a late File metadata result after its %s changes', async change => {
  const rendered=view();await screen.findByText('version2');
  rendered.client.setQueryData(['documentVersions',7],{});
  let finish!: (value: Awaited<ReturnType<typeof fileDocumentApi.versionsList>>)=>void;
  vi.mocked(fileDocumentApi.versionsList).mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));
  await act(async()=>rendered.client.invalidateQueries({queryKey:['documentVersions',7]}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  const nextObject=change==='owner'?{...object,scope:{kind:'project' as const,projectId:3}}:object;
  const nextBinding=change==='binding'?{...binding,generation:'new-generation'}:binding;
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(nextBinding);
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object:nextObject,currentVersionNumber:2,currentContentHash:'hash2',versions:[{...version(1),displayName:'正确名称',isImportant:false,metadataRevision:2}],nextCursor:null});
  vi.mocked(projectFileApi.readBytes).mockImplementation(async(_binding,request)=>({object:nextObject,versionNumber:request.versionNumber,contentHash:`hash${request.versionNumber}`,name:'sample.txt',mime:'text/plain',byteLength:8,base64:btoa(`version${request.versionNumber}`)}));
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue({...source(1),object:nextObject});
  if(change==='owner')rendered.rerender(rendered.wrap({...input,projectId:3,versionNumber:1} as typeof input));
  else await chooseVersion(1);
  await screen.findByText('version1');
  await act(async()=>finish({object,currentVersionNumber:2,currentContentHash:'hash2',versions:[{...version(1),displayName:'迟到旧名称',isImportant:true,metadataRevision:99}],nextCursor:null}));
  fireEvent.click(screen.getByRole('button',{name:'文件查看版本'}));
  expect(screen.getByRole('menuitemradio',{name:'v1（正确名称）'})).toHaveAttribute('aria-checked','true');
  expect(screen.queryByRole('menuitemradio',{name:/迟到旧名称/})).not.toBeInTheDocument();
  rendered.unmount();
});
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
function relatedFixture(rootText: string, rootName: string, rootMime: string, format: 'markdown' | 'html') {
  vi.mocked(projectFileApi.resolve).mockResolvedValue({object,name:rootName,relativePath:rootName,versionNumber:2,contentHash:'hash2',state:'ready',reason:null});
  if(format==='markdown')vi.mocked(fileWorkingApi.open).mockResolvedValue({...workingStatus(),sessionId:'session',name:rootName,base64:btoa(unescape(encodeURIComponent(rootText))),format,model:null});
  const imageObject = { ...object, id: '8' }; const styleObject = { ...object, id: '9' };
  vi.mocked(projectFileApi.resolveRelated).mockImplementation(async (_, _object, relativePath) => ({ object: relativePath.endsWith('.css') ? styleObject : imageObject, versionNumber: 3, contentHash: 'asset3', relativePath, state: 'ready', reason: null, name: relativePath, mime: relativePath.endsWith('.css') ? 'text/css' : 'image/png' }));
  vi.mocked(projectFileApi.readBytes).mockImplementation(async (_, request) => {
    const isRoot = request.object.id === '7';
    const base64 = isRoot ? btoa(rootText) : request.object.id === '9' ? btoa('h1{color:red}') : pngBase64;
    return { object: request.object, versionNumber: request.versionNumber, contentHash: request.expectedContentHash,
      name: isRoot ? rootName : request.object.id === '9' ? 'style.css' : 'a.png', mime: isRoot ? rootMime : request.object.id === '9' ? 'text/css' : 'image/png', base64, byteLength: atob(base64).length };
  });
  vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_, request) => source(request.versionNumber, rootText, rootName, format));
}
it('loads current Markdown relative and reference images only through bound same-Project File resolution', async () => {
  relatedFixture('# Picture\n\n![direct](images/a.png)\n\n![ref][asset]\n\n[asset]: images/a.png', 'sample.md', 'text/markdown', 'markdown');
  const rendered = view();
  // This integration loads the real lazy rich renderer; resource assertions start after it mounts.
  await screen.findByRole("heading",{name:"Picture",exact:true},{timeout:5000});
  await waitFor(() => expect(rendered.container.querySelectorAll('img[src^="data:image/png"]')).toHaveLength(2));
  expect(projectFileApi.resolveRelated).toHaveBeenCalledOnce();
  expect(projectFileApi.resolveRelated).toHaveBeenCalledWith(binding, object, 'images/a.png');
  expect(projectFileApi.readBytes).toHaveBeenLastCalledWith(binding, expect.objectContaining({ object: { ...object, id: '8' }, versionNumber: 3, expectedContentHash: 'asset3' }));
});
it('does not mix current images into historical Markdown when dependent snapshots are unavailable', async () => {
  relatedFixture('![image](images/a.png)', 'sample.md', 'text/markdown', 'markdown');
  const rendered = view({ ...input, versionNumber: 1 } as typeof input);
  await screen.findByText(/历史版本未保留关联资源快照/);
  expect(projectFileApi.resolveRelated).not.toHaveBeenCalled();
  expect(rendered.container.querySelector('img[src]')).toBeNull();
});
it('runs HTML through a fixed native session without reading dependencies in React', async () => {
  relatedFixture('<script>run()</script><link rel="stylesheet" href="style.css">', 'sample.html', 'text/html', 'html');
  const rendered = view();
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledWith(binding, { object, versionNumber: 2, expectedContentHash: 'hash2' }, false));
  expect(projectFileApi.resolveRelated).not.toHaveBeenCalled();
  expect(rendered.container.querySelector('iframe')).toBeNull();
  expect(screen.queryByText('历史版本缺少依赖快照时，相关资源无法加载。')).toBeNull();
});
it('passes historical HTML dependency policy to native without mixing current resources', async () => {
  relatedFixture('<img src="a.png"><script>run()</script>', 'sample.html', 'text/html', 'html');
  const rendered = view({...input,versionNumber:1} as typeof input);
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledWith(binding,{object,versionNumber:1,expectedContentHash:'hash1'},true));
  expect(projectFileApi.resolveRelated).not.toHaveBeenCalled();
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
  expect(rendered.container.querySelector('iframe')).toBeNull();
  expect(screen.getByText('历史版本缺少依赖快照时，相关资源无法加载。')).toBeVisible();
});
it('ignores late current-image resolution when switching the same File to fixed history', async () => {
  relatedFixture('![image](images/a.png)', 'sample.md', 'text/markdown', 'markdown');
  let complete!: (value: unknown) => void;
  vi.mocked(projectFileApi.resolveRelated).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }) as ReturnType<typeof projectFileApi.resolveRelated>);
  const rendered = view();
  await waitFor(() => expect(projectFileApi.resolveRelated).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({ ...input, versionNumber: 1 } as typeof input));
  await screen.findByText(/历史版本未保留关联资源快照/);
  await act(async () => complete({ object: { ...object, id: '8' }, versionNumber: 3, contentHash: 'asset3', state: 'ready', reason: null }));
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
  expect(fileWorkingApi.open).toHaveBeenCalledOnce();
  expect(rendered.container.querySelector('img[src]')).toBeNull();
});
it('reconciles latest before reading the actual registered head, while fixed versions skip live reconciliation', async () => {
  vi.mocked(projectFileApi.resolve).mockImplementation(async () => {
    vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: 3, currentContentHash: 'hash3', versions: [version(3), version(2), version(1)], nextCursor: null });
    return { object, relativePath: 'sample.txt', name: 'sample.txt', versionNumber: 3, contentHash: 'hash3', state: 'ready', reason: null };
  });
  view(); await screen.findByText('version3');
  expect(projectFileApi.resolve).toHaveBeenCalledWith(binding, object);
  expect(projectFileApi.readBytes).toHaveBeenLastCalledWith(binding, { object, versionNumber: 3, expectedContentHash: 'hash3' });
  vi.mocked(projectFileApi.resolve).mockClear();
  await chooseVersion(1);
  await screen.findByText('version1'); expect(projectFileApi.resolve).not.toHaveBeenCalled();
});
it('shows ambiguity reason in latest and keeps retained history readable even when the live file is unavailable', async () => {
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: 'sample.txt', name: 'sample.txt', versionNumber: 2, contentHash: 'hash2', state: 'ambiguous', reason: '此路径已被其他文件占用，请核对' });
  view(); await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('此路径已被其他文件占用');
  expect(projectFileApi.readBytes).not.toHaveBeenCalled();
  await chooseVersion(1);
  await screen.findByText('version1');
});
it('refreshes current related resources on committed dependency changes and releases its subscription when hidden', async () => {
  relatedFixture('![image](images/a.png)', 'sample.md', 'text/markdown', 'markdown');
  const rendered = view();
  await waitFor(() => expect(rendered.container.querySelector('img')).not.toBeNull());
  rendered.client.setQueryData(['documentVersions', 8], {});
  vi.mocked(projectFileApi.resolveRelated).mockClear();
  await act(async () => rendered.client.invalidateQueries({ queryKey: ['documentVersions', 8] }));
  await waitFor(() => expect(projectFileApi.resolveRelated).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({ ...input, visible: false }));
  vi.mocked(projectFileApi.resolveRelated).mockClear();
  await act(async () => rendered.client.invalidateQueries({ queryKey: ['documentVersions', 8] }));
  expect(projectFileApi.resolveRelated).not.toHaveBeenCalled();
});
it('restores shell-supplied scroll and zoom after actual unmount/remount and reports subsequent view changes', async () => {
  const change = vi.fn(); const client = new QueryClient();
  const view = render(<QueryClientProvider client={client}><ProjectFileContent {...input} initialView={{ scrollTop: 88, zoom: 1.5 }} onViewChange={change} /></QueryClientProvider>);
  await screen.findByText('version2');
  const scroll = view.container.querySelector('.dsh-file-preview__scroll') as HTMLElement;
  expect(scroll.scrollTop).toBe(88);
  scroll.scrollTop = 123; fireEvent.scroll(scroll);
  expect(change).toHaveBeenCalledWith({ scrollTop: 123 });
  view.unmount();
  const reopened = render(<QueryClientProvider client={client}><ProjectFileContent {...input} versionNumber={2} initialView={{ scrollTop: 123 }} /></QueryClientProvider>);
  await screen.findByText('version2');
  expect((reopened.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(123);
});
it('renders an image normally when a retained source mode belongs to an older text version', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:image-after-text'); URL.revokeObjectURL = vi.fn();
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.png', mime: 'image/png', byteLength: atob(pngBase64).length, base64: pngBase64 });
  const client = new QueryClient();
  const rendered = render(<QueryClientProvider client={client}><ProjectFileContent {...input} initialSourceMode /></QueryClientProvider>);
  await waitFor(() => expect(rendered.container.querySelector('img')).toHaveAttribute('src', 'blob:image-after-text'));
  expect(screen.queryByRole('button', { name: '源码 / 行定位' })).toBeNull();
});

it('restores an initial image zoom and releases its themed portal and blob on actual unmount', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:restored-image'); URL.revokeObjectURL = vi.fn();
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.png', mime: 'image/png', byteLength: atob(pngBase64).length, base64: pngBase64 });
  const client = new QueryClient();
  const rendered = render(<QueryClientProvider client={client}><ProjectFileContent {...input} initialView={{ zoom: 1.5 }} /></QueryClientProvider>);
  await waitFor(() => expect(rendered.container.querySelector('[data-document-zoom-frame]')).not.toBeNull());
  const zoom = rendered.container.querySelector('[data-document-zoom-frame]') as HTMLElement;
  expect(zoom).toHaveAttribute('data-document-zoom-mode', 'fixed');
  expect(zoom.style.getPropertyValue('--document-zoom')).toBe('1.5');
  rendered.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:restored-image');
  expect(document.querySelector('.dsh-file-preview-portals')).toBeNull();
});

it('reports only the loaded immutable source, clears it before reload/version changes and on hide/unmount', async () => {
  const ready = vi.fn(); const client = new QueryClient();
  const wrap = (props: Parameters<typeof ProjectFileContent>[0]) => <QueryClientProvider client={client}><ProjectFileContent {...props} onSourceReady={ready} /></QueryClientProvider>;
  const rendered = render(wrap(input));
  expect(ready).toHaveBeenLastCalledWith(null);
  await screen.findByText('version2');
  const fixed = { object, revision: 'hash2', fileVersion: 2, recordVersion: null, blockId: null, locator: null, title: 'sample.txt', excerpt: '' };
  expect(ready).toHaveBeenLastCalledWith(fixed);
  // External changes do not mutate the source already loaded in this view.
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: 'sample.txt', name: 'sample.txt', versionNumber: 3, contentHash: 'hash3', state: 'ready', reason: null });
  expect(ready).toHaveBeenLastCalledWith(fixed);
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(ready).toHaveBeenLastCalledWith(null);
  await screen.findByRole('alert');
  expect(ready).toHaveBeenLastCalledWith(null);
  rendered.rerender(wrap({ ...input, versionNumber: 1 }));
  expect(ready).toHaveBeenLastCalledWith(null);
  await screen.findByText('version1');
  expect(ready).toHaveBeenLastCalledWith({ ...fixed, revision: 'hash1', fileVersion: 1 });
  rendered.rerender(wrap({ ...input, versionNumber: 1, visible: false }));
  expect(ready).toHaveBeenLastCalledWith(null);
  rendered.unmount();
  expect(ready).toHaveBeenLastCalledWith(null);
});
it('provides a verified source for unsupported bytes and never publishes a late old source', async () => {
  const ready = vi.fn(); const client = new QueryClient();
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.readBytes>>) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const wrap = (props: Parameters<typeof ProjectFileContent>[0]) => <QueryClientProvider client={client}><ProjectFileContent {...props} onSourceReady={ready} /></QueryClientProvider>;
  const rendered = render(wrap(input));
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledOnce());
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 1, contentHash: 'hash1', name: 'sample.doc', mime: 'application/octet-stream', byteLength: 3, base64: btoa('zip') });
  rendered.rerender(wrap({ ...input, versionNumber: 1 }));
  await screen.findByText(/此格式暂不支持/);
  expect(ready).toHaveBeenLastCalledWith({ object, revision: 'hash1', fileVersion: 1, recordVersion: null, blockId: null, locator: null, title: 'sample.doc', excerpt: '' });
  await act(async () => finish({ object, versionNumber: 2, contentHash: 'hash2', name: 'old.txt', mime: 'text/plain', byteLength: 8, base64: btoa('version2') }));
  expect(ready.mock.calls.filter(([value]) => value?.fileVersion === 2)).toHaveLength(0);
});

it('accepts the actual version view arriving after sourceReady without restoring again on saved scroll updates', async () => {
  const ready = vi.fn(); const changed = vi.fn(); const client = new QueryClient();
  const wrap = (initialView?: {scrollTop?: number;zoom?: number}) => <QueryClientProvider client={client}><ProjectFileContent {...input} initialView={initialView} onSourceReady={ready} onViewChange={changed} /></QueryClientProvider>;
  const rendered = render(wrap());
  await screen.findByText('version2');
  expect(ready).toHaveBeenLastCalledWith(expect.objectContaining({ fileVersion: 2, revision: 'hash2' }));
  rendered.rerender(wrap({ scrollTop: 155, zoom: 0 }));
  const scroll = rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement;
  expect(scroll.scrollTop).toBe(155);
  scroll.scrollTop = 172; fireEvent.scroll(scroll);
  rendered.rerender(wrap({ scrollTop: 172, zoom: 0 }));
  scroll.scrollTop = 183;
  rendered.rerender(wrap({ scrollTop: 172, zoom: 0 }));
  expect(scroll.scrollTop).toBe(183);
  expect(projectFileApi.readBytes).toHaveBeenCalledOnce();
  expect(ready.mock.calls.filter(([value]) => value)).toHaveLength(1);
});

it('restores each actual version from the shell sourceReady render and after hidden unmount', async () => {
  const client = new QueryClient();
  function Shell({ selected, visible = true }: {selected?: number;visible?: boolean}) {
    const [loadedSource, setLoadedSource] = useState<AgentSourceRef | null>(null);
    const fileViews: Record<number, {scrollTop: number}> = { 1: {scrollTop: 44}, 2: {scrollTop: 155} };
    return <QueryClientProvider client={client}>{visible ? <ProjectFileContent {...input} versionNumber={selected} initialView={loadedSource ? fileViews[loadedSource.fileVersion!] : undefined} onSourceReady={setLoadedSource} /> : null}</QueryClientProvider>;
  }
  const rendered = render(<Shell />);
  await screen.findByText('version2');
  expect((rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(155);
  rendered.rerender(<Shell selected={1} />);
  await screen.findByText('version1');
  expect((rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(44);
  rendered.rerender(<Shell selected={1} visible={false} />);
  rendered.rerender(<Shell selected={2} />);
  await screen.findByText('version2');
  expect((rendered.container.querySelector('.dsh-file-preview__scroll') as HTMLElement).scrollTop).toBe(155);
});
it('keeps sourceReady null when the returned bytes do not match the requested version hash', async () => {
  const ready = vi.fn(); const client = new QueryClient();
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'wrong', name: 'sample.txt', mime: 'text/plain', byteLength: 8, base64: btoa('version2') });
  render(<QueryClientProvider client={client}><ProjectFileContent {...input} onSourceReady={ready} /></QueryClientProvider>);
  await screen.findByRole('alert');
  expect(ready.mock.calls.every(([value]) => value === null)).toBe(true);
});

function htmlFixture() {
  vi.mocked(projectFileApi.readBytes).mockImplementation(async (_, request) => {
    const text = `<h1>HTML version ${request.versionNumber}</h1>`;
    return { object: request.object, versionNumber: request.versionNumber, contentHash: request.expectedContentHash, name: 'sample.html', mime: 'text/html', base64: btoa(text), byteLength: text.length };
  });
  vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_, request) => source(request.versionNumber, `<h1>HTML version ${request.versionNumber}</h1>`, 'sample.html', 'html'));
}
it('retains the native HTML session while hidden and revalidating, then rebuilds it on refresh', async () => {
  htmlFixture(); const rendered = view();
  const host = await screen.findByLabelText('原生网页显示区域');
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({...input,visible:false}));
  expect(host.isConnected).toBe(true); expect(htmlPreviewApi.close).not.toHaveBeenCalled();
  rendered.rerender(rendered.wrap(input));
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('原生网页显示区域')).toBe(host);
  expect(htmlPreviewApi.create).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'刷新'}));
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledTimes(2));
  expect(htmlPreviewApi.close).toHaveBeenCalledWith('native-1');
  expect(screen.queryByRole('alert')).toBeNull();
  rendered.unmount(); expect(htmlPreviewApi.close).toHaveBeenCalledWith('native-2');
});
it('retires hidden HTML immediately when revalidation discovers a different latest version before bytes arrive', async () => {
  htmlFixture(); const rendered = view();
  await screen.findByLabelText('原生网页显示区域');
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledOnce());
  rendered.rerender(rendered.wrap({...input,visible:false}));
  vi.mocked(projectFileApi.resolve).mockResolvedValue({object,relativePath:'sample.html',name:'sample.html',versionNumber:3,contentHash:'hash3',state:'ready',reason:null});
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({object,currentVersionNumber:3,currentContentHash:'hash3',versions:[version(3),version(2),version(1)],nextCursor:null});
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.readBytes>>) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  rendered.rerender(rendered.wrap(input));
  await waitFor(() => expect(htmlPreviewApi.close).toHaveBeenCalledWith('native-1'));
  expect(screen.queryByLabelText('原生网页显示区域')).toBeNull();
  await act(async () => finish({object,versionNumber:3,contentHash:'hash3',name:'sample.html',mime:'text/html',base64:btoa('<h1>HTML version 3</h1>'),byteLength:23}));
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenLastCalledWith(binding,{object,versionNumber:3,expectedContentHash:'hash3'},false));
});
it('releases retained HTML after a real read failure and never publishes old source as ready', async () => {
  htmlFixture(); const ready = vi.fn(); const client = new QueryClient();
  const wrap = (visible: boolean) => <QueryClientProvider client={client}><ProjectFileContent {...input} visible={visible} onSourceReady={ready} /></QueryClientProvider>;
  const rendered = render(wrap(true)); await screen.findByLabelText('原生网页显示区域');
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledOnce());
  rendered.rerender(wrap(false)); ready.mockClear();
  vi.mocked(projectFileApi.readBytes).mockRejectedValueOnce({message:'snapshot unavailable'});
  rendered.rerender(wrap(true));
  expect(await screen.findByRole('alert')).toHaveTextContent('snapshot unavailable');
  expect(htmlPreviewApi.close).toHaveBeenCalledWith('native-1');
  expect(ready.mock.calls.every(([value]) => value === null)).toBe(true);
});
it('retires HTML on a fixed-version change while hidden and ignores the late old refresh read', async () => {
  htmlFixture(); const rendered = view();
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledOnce());
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.readBytes>>) => void;
  vi.mocked(projectFileApi.readBytes).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  fireEvent.click(screen.getByRole('button',{name:'刷新'}));
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledTimes(2));
  rendered.rerender(rendered.wrap({...input,visible:false,versionNumber:1} as typeof input));
  await waitFor(() => expect(htmlPreviewApi.close).toHaveBeenCalledWith('native-1'));
  await act(async () => finish({object,versionNumber:2,contentHash:'hash2',name:'sample.html',mime:'text/html',base64:btoa('<h1>old</h1>'),byteLength:12}));
  expect(htmlPreviewApi.create).toHaveBeenCalledOnce();
  rendered.rerender(rendered.wrap({...input,versionNumber:1} as typeof input));
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenLastCalledWith(binding,{object,versionNumber:1,expectedContentHash:'hash1'},true));
  expect(screen.queryByRole('alert')).toBeNull();
});
it('binds HTML source mode to the shell, closes native, preserves source through refresh and hide', async () => {
  htmlFixture(); const changed = vi.fn(); const client = new QueryClient();
  const wrap = (visible: boolean, mode = true) => <QueryClientProvider client={client}><ProjectFileContent {...input} visible={visible} initialSourceMode={mode} onViewChange={changed} /></QueryClientProvider>;
  const rendered = render(wrap(true)); await screen.findByText('<h1>HTML version 2</h1>');
  expect(htmlPreviewApi.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'网页',exact:true}));
  expect(changed).toHaveBeenLastCalledWith({sourceMode:false});
  await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledOnce());
  rendered.rerender(wrap(true,false));
  fireEvent.click(screen.getByRole('button',{name:'源码 / 行定位'}));
  expect(htmlPreviewApi.close).toHaveBeenCalledWith('native-1');
  expect(changed).toHaveBeenLastCalledWith({sourceMode:true});
  rendered.rerender(wrap(true,true)); fireEvent.click(screen.getByRole('button',{name:'刷新'}));
  await screen.findByText('<h1>HTML version 2</h1>');
  rendered.rerender(wrap(false)); expect(rendered.container.querySelector('.dsh-file-preview')).toBeNull();
  rendered.rerender(wrap(true)); await screen.findByText('<h1>HTML version 2</h1>');
  expect(htmlPreviewApi.create).toHaveBeenCalledOnce(); expect(rendered.container.querySelector('iframe')).toBeNull();
});
it('retains separate native sessions in visited Projects with source readiness scoped to the visible Project', async () => {
  htmlFixture(); const client = new QueryClient(); const readyA = vi.fn(); const readyB = vi.fn();
  vi.mocked(projectFileApi.resolve).mockImplementation(async (_, target) => ({object:target,relativePath:'sample.html',name:'sample.html',versionNumber:2,contentHash:'hash2',state:'ready',reason:null}));
  vi.mocked(fileDocumentApi.versionsList).mockImplementation(async (_, request) => ({object:request.object,currentVersionNumber:2,currentContentHash:'hash2',versions:[version(2),version(1)],nextCursor:null}));
  vi.mocked(fileDocumentApi.sourceRead).mockImplementation(async (_, request) => ({...source(request.versionNumber,`<h1>HTML version ${request.versionNumber}</h1>`,'sample.html','html'),object:request.object}));
  const wrap = (active: number) => <QueryClientProvider client={client}>
    <ProjectFileContent {...input} visible={active===2} onSourceReady={readyA} />
    <ProjectFileContent {...input} projectId={3} visible={active===3} onSourceReady={readyB} />
  </QueryClientProvider>;
  const rendered = render(wrap(2)); await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledOnce());
  rendered.rerender(wrap(3)); await waitFor(() => expect(htmlPreviewApi.create).toHaveBeenCalledTimes(2));
  expect(htmlPreviewApi.close).not.toHaveBeenCalled(); expect(readyA).toHaveBeenLastCalledWith(null);
  expect(readyB).toHaveBeenLastCalledWith(expect.objectContaining({object:expect.objectContaining({scope:{kind:'project',projectId:3}})}));
  rendered.rerender(wrap(2)); await waitFor(() => expect(readyA).toHaveBeenLastCalledWith(expect.objectContaining({object})));
  expect(htmlPreviewApi.create).toHaveBeenCalledTimes(2); expect(htmlPreviewApi.close).not.toHaveBeenCalled();
  expect(readyB).toHaveBeenLastCalledWith(null);
});
it('releases image bodies and Blob resources when hidden instead of retaining non-HTML content', async () => {
  URL.createObjectURL = vi.fn(() => 'blob:hidden-image'); URL.revokeObjectURL = vi.fn();
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 2, contentHash: 'hash2', name: 'sample.png', mime: 'image/png', byteLength: atob(pngBase64).length, base64: pngBase64 });
  const rendered = view(); await waitFor(() => expect(rendered.container.querySelector('[data-document-zoom-frame]')).not.toBeNull());
  rendered.rerender(rendered.wrap({...input,visible:false}));
  expect(rendered.container.querySelector('[data-document-zoom-frame]')).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:hidden-image');
  expect(document.querySelector('.dsh-file-preview-portals')).toBeNull();
});
it('restores Markdown source mode from the shell without rereading bytes when the mode changes', async () => {
  relatedFixture('# Markdown', 'sample.md', 'text/markdown', 'markdown'); const client = new QueryClient(); const changed = vi.fn();
  const wrap = (mode: boolean) => <QueryClientProvider client={client}><ProjectFileContent {...input} initialSourceMode={mode} onViewChange={changed} /></QueryClientProvider>;
  const rendered = render(wrap(true));
  const sourceEditor = await screen.findByRole('textbox', {name:'Markdown 源码'},{timeout:5000});
  expect(sourceEditor).toHaveTextContent('# Markdown');
  expect(sourceEditor).toHaveAttribute('contenteditable', 'true');
  rendered.rerender(wrap(false)); await screen.findByRole('heading', {name:'Markdown'});
  expect(rendered.container.querySelector('.project-file-content__toolbar button[aria-label="源码 / 行定位"]')).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'源码',exact:true}));
  expect(changed).toHaveBeenLastCalledWith({mode:'source',sourceMode:true});
  expect(projectFileApi.readBytes).not.toHaveBeenCalled();expect(fileWorkingApi.open).toHaveBeenCalledOnce();
});

it('exposes external open on unsupported and pinned File views as the current original', async () => {
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object, versionNumber: 1, contentHash: 'hash1', name: 'sample.doc', mime: 'application/octet-stream', byteLength: 2, base64: btoa('PK') });
  view({ ...input, versionNumber: 1 } as typeof input);
  const open = await screen.findByRole('button', { name: '在外部应用打开当前原件' });
  await screen.findByText(/此格式暂不支持应用内预览或编辑/);
  expect(open).toHaveAttribute('title', expect.stringContaining('当前原件'));
  fireEvent.click(open);
  await waitFor(() => expect(projectFileApi.openLocal).toHaveBeenCalledWith(binding, object));
  expect(screen.getByRole('button', {name:'文件查看版本'})).toHaveTextContent('v1');
});
it('shows external open failures and permits retry without changing the fixed version', async () => {
  vi.mocked(projectFileApi.openLocal).mockRejectedValueOnce(new Error('没有关联应用')).mockResolvedValueOnce(undefined);
  view({ ...input, versionNumber: 1 } as typeof input); await screen.findByText('version1');
  fireEvent.click(screen.getByRole('button', {name:'在外部应用打开当前原件'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('没有关联应用');
  fireEvent.click(screen.getByRole('button', {name:'在外部应用打开当前原件'}));
  await waitFor(() => expect(projectFileApi.openLocal).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('button', {name:'文件查看版本'})).toHaveTextContent('v1');
});
it('shows the recovery slot only after current File identity needs attention', async () => {
  const client = new QueryClient();
  const wrap = () => <QueryClientProvider client={client}><ProjectFileContent {...input} identityRecovery={() => <button>文件位置核对入口</button>} /></QueryClientProvider>;
  const rendered = render(wrap()); await screen.findByText('version2');
  expect(screen.queryByText('文件位置核对入口')).toBeNull();
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath:'sample.txt', name:'sample.txt', versionNumber:2, contentHash:'hash2', state:'missing', reason:'文件缺失' });
  fireEvent.click(screen.getByRole('button',{name:'刷新'}));
  expect(await screen.findByText('文件位置核对入口')).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('文件缺失');
  await chooseVersion(1);
  await screen.findByText('version1');
  expect(screen.getByText('文件位置核对入口')).toBeInTheDocument();
  rendered.unmount();
});

it.each([{projectId:3},{fileId:8},{visible:false}])('cancels an external-open lookup when the File page changes %j', async change => {
  const rendered=view(); await screen.findByText('version2');
  let finish!: (value:typeof binding)=>void;
  vi.mocked(recordDocumentApi.bindingGet).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  fireEvent.click(screen.getByRole('button',{name:'在外部应用打开当前原件'}));
  await waitFor(()=>expect(finish).toBeTypeOf('function'));
  rendered.rerender(rendered.wrap({...input,...change}));
  await act(async()=>finish(binding));
  expect(projectFileApi.openLocal).not.toHaveBeenCalled();
});
it('preserves the compact toolbar and fixed version label through refresh without resetting to latest',async()=>{
  const client=new QueryClient();
  render(<QueryClientProvider client={client}><ProjectFileContent {...input} versionNumber={1} toolbarActions={<button>测试引用入口</button>} /></QueryClientProvider>);
  await screen.findByText('version1');
  const select=screen.getByRole('button',{name:'文件查看版本'});
  expect(select).toHaveTextContent('v1');
  expect(screen.getByRole('button',{name:'测试引用入口'}).closest('header')).toBe(select.closest('header'));
  expect(screen.queryByRole('button',{name:'复制完整源码'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'刷新'}));
  await waitFor(()=>expect(projectFileApi.readBytes).toHaveBeenCalledTimes(2));
  expect(select).toHaveTextContent('v1'); expect(projectFileApi.resolve).not.toHaveBeenCalled();
});

it("opens a Workspace-owned file through the shared version and byte pipeline without a Project identity", async () => {
  const workspaceFile = { ...object, scope: { kind: "workspace" as const } };
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object: workspaceFile, relativePath: "sample.txt", name: "sample.txt", versionNumber: 2, contentHash: "hash2", state: "ready", reason: null });
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object: workspaceFile, currentVersionNumber: 2, currentContentHash: "hash2", versions: [version(2), version(1)], nextCursor: null });
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ object: workspaceFile, versionNumber: 2, contentHash: "hash2", name: "sample.txt", mime: "text/plain", byteLength: 9, base64: btoa("workspace") });
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue({ ...source(2, "workspace"), object: workspaceFile });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ProjectFileContent {...input} projectId={null} /></QueryClientProvider>);
  await waitFor(() => expect(projectFileApi.readBytes).toHaveBeenCalledWith(binding, { object: workspaceFile, versionNumber: 2, expectedContentHash: "hash2" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it('keeps the failed Office version selection open and preserves its draft and CAS baseline for retry', async () => {
  vi.mocked(fileWorkingApi.saveOffice).mockRejectedValue(new Error('保存冲突'));
  const rendered = await editedOffice();
  await chooseVersion(1);
  await waitFor(() => expect(screen.getByRole('menu', {name:'文件查看版本列表'})).toHaveTextContent('保存冲突'));
  expect(screen.getByRole('button', {name:'文件查看版本'})).toHaveTextContent('当前内容');
  expect(rendered.editor).toHaveValue('未保存草稿');
  expect(fileWorkingApi.saveOffice).toHaveBeenCalledWith(binding, expect.objectContaining({sessionId:'session',expectedRevision:2,expectedContentHash:'hash2'}), expect.any(String));
  vi.mocked(fileWorkingApi.saveOffice).mockResolvedValue({...workingStatus(),revision:3,contentHash:'hash3',pendingArchive:true});
  fireEvent.click(screen.getByRole('menuitemradio', {name:'v1',exact:true}));
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(screen.getByRole('button', {name:'文件查看版本'})).toHaveTextContent('v1');
  rendered.unmount();
});


it('mounts Markdown text and controls before images settle, and reveals each completed image independently', async () => {
  relatedFixture('# Text first\n\n![slow](images/slow.png)\n\n![fast](images/fast.png)', 'sample.md', 'text/markdown', 'markdown');
  const originalResolve = vi.mocked(projectFileApi.resolveRelated).getMockImplementation()!;
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.resolveRelated>>) => void;
  vi.mocked(projectFileApi.resolveRelated).mockImplementation((...args) => args[2] === 'images/slow.png' ? new Promise(resolve => { finish = resolve; }) : originalResolve(...args));
  const rendered = view();
  await screen.findByRole('heading', { name: 'Text first', exact: true }, { timeout: 5000 });
  expect(screen.getByRole('button', { name: '源码', exact: true })).toBeEnabled();
  expect(screen.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await waitFor(() => expect(rendered.container.querySelector('img[alt="fast"]')).toHaveAttribute('src', expect.stringContaining('data:image/png')));
  expect(rendered.container.querySelector('img[alt="slow"]')).not.toHaveAttribute('src');
  fireEvent.click(screen.getByRole('button', { name: '源码', exact: true }));
  expect(await screen.findByRole('textbox', { name: 'Markdown 源码' })).toHaveAttribute('contenteditable', 'true');
  await act(async () => finish(await originalResolve(binding, object, 'images/slow.png')));
  fireEvent.click(screen.getByRole('button', { name: '块编辑', exact: true }));
  await waitFor(() => expect(rendered.container.querySelector('img[alt="slow"]')).toHaveAttribute('src', expect.stringContaining('data:image/png')));
});

it('keeps Markdown text visible and reports an asynchronous image failure locally', async () => {
  relatedFixture('# Still readable\n\n![image](images/a.png)', 'sample.md', 'text/markdown', 'markdown');
  let reject!: (reason: Error) => void;
  vi.mocked(projectFileApi.resolveRelated).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  view();
  await screen.findByRole('heading', { name: 'Still readable', exact: true }, { timeout: 5000 });
  await act(async () => reject(new Error('图片暂不可用')));
  expect(await screen.findByRole('alert')).toHaveTextContent('图片暂不可用');
  expect(screen.getByRole('heading', { name: 'Still readable', exact: true })).toBeVisible();
  expect(screen.getByRole('button', { name: '源码', exact: true })).toBeEnabled();
});

it('does not continue image reads after its Markdown document has unmounted', async () => {
  relatedFixture('# Leaving\n\n![image](images/a.png)', 'sample.md', 'text/markdown', 'markdown');
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.resolveRelated>>) => void;
  vi.mocked(projectFileApi.resolveRelated).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const rendered = view();
  await screen.findByRole('heading', { name: 'Leaving', exact: true }, { timeout: 5000 });
  await waitFor(() => expect(projectFileApi.resolveRelated).toHaveBeenCalledOnce());
  rendered.unmount();
  await act(async () => finish({ object: { ...object, id: '8' }, versionNumber: 3, contentHash: 'asset3', relativePath: 'images/a.png', state: 'ready', reason: null, name: 'a.png', mime: 'image/png' }));
  expect(projectFileApi.readBytes).not.toHaveBeenCalled();
});


it('rejects asynchronous initial images if the original Markdown version changes while reading them', async () => {
  relatedFixture('# Fixed text\n\n![image](images/a.png)', 'sample.md', 'text/markdown', 'markdown');
  const originalResolve = vi.mocked(projectFileApi.resolveRelated).getMockImplementation()!;
  let finish!: (value: Awaited<ReturnType<typeof projectFileApi.resolveRelated>>) => void;
  vi.mocked(projectFileApi.resolveRelated).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const rendered = view();
  await screen.findByRole('heading', { name: 'Fixed text', exact: true }, { timeout: 5000 });
  await waitFor(() => expect(projectFileApi.resolveRelated).toHaveBeenCalledOnce());
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: 'sample.md', name: 'sample.md', versionNumber: 3, contentHash: 'hash3', state: 'ready', reason: null });
  vi.mocked(fileWorkingApi.tick).mockResolvedValue({...workingStatus(),revision:3,contentHash:'hash3'});
  await act(async () => finish(await originalResolve(binding, object, 'images/a.png')));
  expect(await screen.findByRole('alert')).toHaveTextContent('文件在关联资源读取期间发生变化');
  expect(screen.getByRole('heading', { name: 'Fixed text', exact: true })).toBeVisible();
  expect(rendered.container.querySelector('img[alt="image"]')).not.toHaveAttribute('src');
});

it('renders embedded Markdown data images without external resource requests', async () => {
  relatedFixture(`# Embedded\n\n![inline](data:image/png;base64,${pngBase64})`, 'sample.md', 'text/markdown', 'markdown');
  const rendered = view();
  await screen.findByRole('heading', { name: 'Embedded', exact: true }, { timeout: 5000 });
  expect(rendered.container.querySelector('img[alt="inline"]')).toHaveAttribute('src', `data:image/png;base64,${pngBase64}`);
  expect(projectFileApi.resolveRelated).not.toHaveBeenCalled();
});
