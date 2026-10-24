import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectFileSessionReference } from "./ProjectFileSessionReference";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { dshAssistantApi } from "../../services/dshAssistantApi";
import { setDshWorkspaceRoot, useDshFileReferences } from "../../lib/dsh-host-events";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import { useProjectContentStore } from "../../state/project-content-store";
import { getContentLayout } from "../../lib/project-content-layout";
import { PROJECT_CONTENT_OPEN_EVENT } from "../../services/projectContentApi";
import type { AgentSourceRef } from "../../lib/agent-types";
import type { FileBytesResult } from "../../lib/file-types";
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { resolve: vi.fn(), readBytes: vi.fn() } }));
vi.mock("../../services/dshAssistantApi", () => ({ dshAssistantApi: { start: vi.fn(), sessions: vi.fn(), selectSession: vi.fn() } }));
const binding = { workspaceId: "reference-workspace", generation: "open-1" };
const object = { workspaceId: binding.workspaceId, scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "51" };
const bytes: FileBytesResult = { object, versionNumber: 2, contentHash: "sha256:retained-v2", name: "historical.txt", mime: "text/plain", byteLength: 3, base64: btoa("old") };
const source: AgentSourceRef = { object, revision: bytes.contentHash, fileVersion: 2, recordVersion: null, blockId: null, locator: null, title: "historical.txt", excerpt: "" };
const props = { workspaceRoot: "/tmp/reference-workspace", projectId: 7, fileId: 51, versionNumber: 2, sourceRef: source };
const pending = () => useDshFileReferences.getState().pending;
function insert() { fireEvent.click(screen.getByRole("button", { name: "引用到新会话" })); }
beforeEach(() => {
  vi.resetAllMocks(); useProjectContentStore.setState({ layouts: {} });
  useAgentPanelStore.getState().clearWorkspace(); setDshWorkspaceRoot(null); setDshWorkspaceRoot(props.workspaceRoot);
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(dshAssistantApi.start).mockResolvedValue(undefined);
  vi.mocked(dshAssistantApi.selectSession).mockResolvedValue("session-new");
  vi.mocked(dshAssistantApi.sessions).mockResolvedValue([{ id: "session-a", title: "材料分析", running: true }, { id: "session-new", title: "新会话", running: false }, { id: "session-next", title: "另一个新会话", running: false }]);
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath: "renamed/current.txt", name: "current.txt", versionNumber: 3, contentHash: "sha256:current-v3", state: "ready", reason: null });
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object, currentVersionNumber: 3, currentContentHash: "sha256:current-v3",
    versions: [{ id: "retained-2", versionNumber: 2, name: bytes.name, contentHash: bytes.contentHash, createdAt: "yesterday", isCurrent: false }], nextCursor: null });
  vi.mocked(projectFileApi.readBytes).mockResolvedValue(bytes);
});
afterEach(() => { setDshWorkspaceRoot(null); });

it("verifies displayed bytes before creating a new Session and queues the fixed reference before reveal", async () => {
  const view = render(<ProjectFileSessionReference {...props} />);
  const reveal = vi.fn(() => { expect(pending()).toHaveLength(1); view.unmount(); });
  window.addEventListener(PROJECT_CONTENT_OPEN_EVENT, reveal);
  try {
    insert();
    await waitFor(() => expect(reveal).toHaveBeenCalledOnce());
    expect(screen.queryByRole("combobox", { name: "目标会话" })).toBeNull();
    expect(pending()[0]).toMatchObject({ workspaceRoot:props.workspaceRoot, projectId:7, sessionId:"session-new", path:"renamed/current.txt", sourceRef:source });
    expect(projectFileApi.readBytes).toHaveBeenCalledWith(binding, {object, versionNumber:2, expectedContentHash:bytes.contentHash});
    expect(fileDocumentApi.versionsList).toHaveBeenCalledWith(binding,{object,cursor:3,limit:1});
    expect(dshAssistantApi.selectSession).toHaveBeenCalledWith(null, 7);
    expect(vi.mocked(projectFileApi.readBytes).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(dshAssistantApi.selectSession).mock.invocationCallOrder[0]);
    expect(getContentLayout(useProjectContentStore.getState(), {workspaceId:binding.workspaceId,projectId:7}).tabs.map(tab=>tab.object.id)).toEqual(["session-new"]);
    expect(useAgentPanelStore.getState().open).toBe(false);
  } finally { window.removeEventListener(PROJECT_CONTENT_OPEN_EVENT,reveal); }
});
it("keeps pinned references immutable when the current File advances and subsequent clicks create new Sessions", async () => {
  render(<ProjectFileSessionReference {...props} />); insert();
  await waitFor(() => expect(pending()).toHaveLength(1));
  const first = structuredClone(pending()[0]);
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object, relativePath:"again/moved.txt", name:"moved.txt", versionNumber:4, contentHash:"sha256:new-v4",state:"ready",reason:null });
  vi.mocked(dshAssistantApi.selectSession).mockResolvedValueOnce("session-next");
  insert(); await waitFor(()=>expect(pending()).toHaveLength(2));
  expect(pending()[0]).toEqual(first);
  expect(pending()[1]).toMatchObject({sessionId:"session-next",path:"again/moved.txt",sourceRef:source});
});
it("queues the reference before opening the new Tab hides its originating File", async () => {
  const view = render(<ProjectFileSessionReference {...props} />);
  const unsubscribe = useProjectContentStore.subscribe(state => {
    if (getContentLayout(state, {workspaceId:binding.workspaceId,projectId:7}).tabs.some(tab=>tab.object.kind === "session"))
      flushSync(()=>view.rerender(<ProjectFileSessionReference {...props} visible={false} sourceRef={null} />));
  });
  const revealed = vi.fn(); window.addEventListener(PROJECT_CONTENT_OPEN_EVENT, revealed);
  try {
    insert();
    await waitFor(()=>expect(pending()).toHaveLength(1));
    expect(pending()[0]).toMatchObject({sessionId:"session-new",sourceRef:source});
    expect(revealed).toHaveBeenCalledOnce();
  } finally { unsubscribe(); window.removeEventListener(PROJECT_CONTENT_OPEN_EVENT,revealed); }
});
it("does not create a Session for a missing snapshot and permits retry", async () => {
  vi.mocked(projectFileApi.readBytes).mockRejectedValueOnce(new Error("固定版本快照不存在"));
  render(<ProjectFileSessionReference {...props} />); insert();
  expect(await screen.findByRole("alert")).toHaveTextContent("固定版本快照不存在");
  expect(dshAssistantApi.selectSession).not.toHaveBeenCalled(); expect(pending()).toHaveLength(0);
  insert(); await waitFor(()=>expect(pending()).toHaveLength(1));
});
it.each([
  { object: {...object,id:"52"} }, {object:{...object,kind:"record" as const}}, {versionNumber:3}, {contentHash:"sha256:wrong"},
])("rejects mismatched bytes %j before Session creation", async change => {
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({...bytes,...change});
  render(<ProjectFileSessionReference {...props} />); insert();
  expect(await screen.findByRole("alert")).toHaveTextContent("文件版本与引用目标不符");
  expect(dshAssistantApi.selectSession).not.toHaveBeenCalled(); expect(pending()).toHaveLength(0);
});
it("rejects a hash different from the displayed source", async () => {
  render(<ProjectFileSessionReference {...props} sourceRef={{...source,revision:"sha256:wrong"}} />); insert();
  expect(await screen.findByRole("alert")).toHaveTextContent("无法建立固定引用");
  expect(dshAssistantApi.selectSession).not.toHaveBeenCalled();
});
it("rejects Workspace generation changes before creating a Session", async () => {
  let finish!: (result:FileBytesResult)=>void;
  vi.mocked(projectFileApi.readBytes).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  render(<ProjectFileSessionReference {...props} />); insert(); await waitFor(()=>expect(finish).toBeTypeOf("function"));
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({...binding,generation:"open-2"});
  await act(async()=>finish(bytes));
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换");
  expect(dshAssistantApi.selectSession).not.toHaveBeenCalled(); expect(pending()).toHaveLength(0);
});
it.each([{fileId:52},{projectId:8},{versionNumber:3},{workspaceRoot:"/another/workspace"},{sourceRef:null},{visible:false}])("cancels pending insertion after props change %j", async change=>{
  let finish!: (result:FileBytesResult)=>void;
  vi.mocked(projectFileApi.readBytes).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<ProjectFileSessionReference {...props} />); insert(); await waitFor(()=>expect(finish).toBeTypeOf("function"));
  view.rerender(<ProjectFileSessionReference {...props} {...change} />);
  await act(async()=>finish(bytes));
  expect(pending()).toHaveLength(0); expect(dshAssistantApi.selectSession).not.toHaveBeenCalled(); expect(useProjectContentStore.getState().layouts).toEqual({});
});
it("disables unverified sources and rejects stale pinned source versions", async()=>{
  const view=render(<ProjectFileSessionReference {...props} sourceRef={null} />);
  expect(screen.getByRole("button",{name:"引用到新会话"})).toBeDisabled();
  view.rerender(<ProjectFileSessionReference {...props} versionNumber={3} />); insert();
  expect(await screen.findByRole("alert")).toHaveTextContent("预览版本已变化"); expect(dshAssistantApi.selectSession).not.toHaveBeenCalled();
});
it("uses the displayed SourceRef in latest mode even when the live File has advanced",async()=>{
  render(<ProjectFileSessionReference {...props} versionNumber={undefined} />); insert();
  await waitFor(()=>expect(pending()).toHaveLength(1)); expect(pending()[0].sourceRef).toEqual(source);
});
it("blocks repeated clicks during Session creation and cancels delivery after unmount",async()=>{
  let finish!: (id:string)=>void;
  vi.mocked(dshAssistantApi.selectSession).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<ProjectFileSessionReference {...props} />); insert();
  await waitFor(()=>expect(finish).toBeTypeOf("function"));
  insert(); expect(dshAssistantApi.selectSession).toHaveBeenCalledOnce();
  view.unmount(); await act(async()=>finish("session-new"));
  expect(pending()).toHaveLength(0); expect(useProjectContentStore.getState().layouts).toEqual({});
});
it("shows runtime failures and reuses a created Session if delivery failed on the first try",async()=>{
  vi.mocked(dshAssistantApi.sessions).mockRejectedValueOnce(new Error("会话列表不可用"));
  render(<ProjectFileSessionReference {...props} />); insert();
  expect(await screen.findByRole("alert")).toHaveTextContent("会话列表不可用"); expect(pending()).toHaveLength(0);
  insert(); await waitFor(()=>expect(pending()).toHaveLength(1));
  expect(dshAssistantApi.selectSession).toHaveBeenCalledOnce();
});

it("rejects history ownership before creating a Session", async()=>{
  const history=await fileDocumentApi.versionsList(binding,{object,limit:1});
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({...history,object:{...object,scope:{kind:"project",projectId:8}}});
  render(<ProjectFileSessionReference {...props} />); insert();
  expect(await screen.findByRole("alert")).toHaveTextContent("历史版本归属"); expect(dshAssistantApi.selectSession).not.toHaveBeenCalled();
});
it("rejects a source belonging to another Project before resolving it",async()=>{
  render(<ProjectFileSessionReference {...props} sourceRef={{...source,object:{...object,scope:{kind:"project",projectId:8}}}} />); insert();
  expect(await screen.findByRole("alert")).toHaveTextContent("预览文件归属");
  expect(projectFileApi.resolve).not.toHaveBeenCalled(); expect(dshAssistantApi.selectSession).not.toHaveBeenCalled();
});
it("shows Session creation failure and retries creation on the next click",async()=>{
  vi.mocked(dshAssistantApi.selectSession).mockRejectedValueOnce(new Error("创建会话失败"));
  render(<ProjectFileSessionReference {...props} />); insert();
  expect(await screen.findByRole("alert")).toHaveTextContent("创建会话失败"); expect(pending()).toHaveLength(0);
  insert(); await waitFor(()=>expect(pending()).toHaveLength(1)); expect(dshAssistantApi.selectSession).toHaveBeenCalledTimes(2);
});
it("rejects a Session that is absent from the current Project instead of referencing an active old Session",async()=>{
  vi.mocked(dshAssistantApi.selectSession).mockResolvedValueOnce("foreign-session");
  render(<ProjectFileSessionReference {...props} />); insert();
  expect(await screen.findByRole("alert")).toHaveTextContent("会话不存在或不属于当前范围");
  expect(pending()).toHaveLength(0); expect(useProjectContentStore.getState().layouts).toEqual({});
});
it("cancels delivery when displayed-source identity changes during Session creation",async()=>{
  let finish!: (id:string)=>void;
  vi.mocked(dshAssistantApi.selectSession).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const view=render(<ProjectFileSessionReference {...props} />); insert(); await waitFor(()=>expect(finish).toBeTypeOf("function"));
  view.rerender(<ProjectFileSessionReference {...props} sourceRef={{...source,revision:"sha256:new-preview"}} />);
  await act(async()=>finish("session-new")); expect(pending()).toHaveLength(0); expect(useProjectContentStore.getState().layouts).toEqual({});
});

it("references a Workspace-owned fixed File version in a Workspace session using its real files path", async () => {
  const workspaceObject = { ...object, scope: { kind: "workspace" as const } };
  const workspaceSource = { ...source, object: workspaceObject };
  vi.mocked(projectFileApi.resolve).mockResolvedValue({ object: workspaceObject, relativePath: "renamed/current.txt", name: "current.txt", versionNumber: 3, contentHash: "sha256:current-v3", state: "ready", reason: null });
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ object: workspaceObject, currentVersionNumber: 3, currentContentHash: "sha256:current-v3", versions: [{ id: "retained-2", versionNumber: 2, name: bytes.name, contentHash: bytes.contentHash, createdAt: "yesterday", isCurrent: false }], nextCursor: null });
  vi.mocked(projectFileApi.readBytes).mockResolvedValue({ ...bytes, object: workspaceObject });
  render(<ProjectFileSessionReference {...props} projectId={null} sourceRef={workspaceSource} />);
  insert();
  await waitFor(() => expect(pending()).toHaveLength(1));
  expect(pending()[0]).toMatchObject({ projectId: null, path: "files/renamed/current.txt", sourceRef: workspaceSource });
  expect(getContentLayout(useProjectContentStore.getState(), { workspaceId: binding.workspaceId, projectId: null }).tabs.map(tab => tab.object.id)).toEqual(["session-new"]);
});
