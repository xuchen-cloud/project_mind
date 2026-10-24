import type { AgentObjectRef, AgentWorkspaceBinding } from "../lib/agent-types";
import { getContentLayout, type ContentObject, type ContentPane, type ContentScope, type ContentView } from "../lib/project-content-layout";
import { useProjectContentStore } from "../state/project-content-store";
import { recordDocumentApi } from "./recordDocumentApi";
import { fileDocumentApi } from "./fileDocumentApi";
import { dshAssistantApi, type DshSessionAction } from "./dshAssistantApi";

export const PROJECT_CONTENT_OPEN_EVENT = "project-mind:content-open";
export interface ProjectContentOpenResult {
  workspaceRoot: string;
  scope: ContentScope;
  tabId: string;
  object: ContentObject;
  view?: ContentView;
}
export interface ProjectContentOpenInput {
  workspaceRoot: string;
  projectId: number | null;
  object: ContentObject;
  view?: ContentView;
  paneId?: ContentPane["id"];
  reveal?: boolean;
  signal?: AbortSignal;
  expectedBinding?: AgentWorkspaceBinding;
  /** Deliver a verified reference before the layout change can hide its origin. */
  beforeOpen?: () => void;
}

function assertCurrent(before: AgentWorkspaceBinding, after: AgentWorkspaceBinding, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("打开已取消", "AbortError");
  if (before.workspaceId !== after.workspaceId || before.generation !== after.generation)
    throw new Error("工作区已切换，请重新打开内容");
}

/** Verify native ownership, then atomically deduplicate in the same scoped layout. */
export async function openProjectContent(input: ProjectContentOpenInput): Promise<ProjectContentOpenResult> {
  if (input.projectId !== null && (!Number.isSafeInteger(input.projectId) || input.projectId <= 0)) throw new Error("无效项目身份");
  const binding = await recordDocumentApi.bindingGet(input.workspaceRoot);
  if (input.expectedBinding) assertCurrent(input.expectedBinding, binding, input.signal);
  const targetScope = input.projectId === null ? { kind: "workspace" as const } : { kind: "project" as const, projectId: input.projectId };
  const ownsScope = (scope: { kind: string; projectId?: number }) => scope.kind === targetScope.kind && (scope.kind !== "project" || scope.projectId === input.projectId);
  const object: ContentObject = { kind: input.object.kind, id: input.object.id, title: input.object.title };
  if (object.kind === "session") {
    if (typeof object.id !== "string" || !object.id) throw new Error("无效会话身份");
    await dshAssistantApi.start(`${binding.workspaceId}:${binding.generation}`, input.projectId);
    const session = (await dshAssistantApi.sessions(input.projectId)).find(item => item.id === object.id);
    if (!session) throw new Error("会话不存在或不属于当前范围");
    object.title = session.title || "新会话";
  } else {
    const id = typeof object.id === "number" ? object.id : /^\d+$/u.test(object.id) ? Number(object.id) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("无效内容身份");
    object.id = id;
    if (object.kind === "record") {
      const state = await recordDocumentApi.editorGet(binding, { scope: targetScope, recordId: id });
      if (!ownsScope(state.head.target.scope) || state.head.target.recordId !== id)
        throw new Error("记录归属与请求范围不符");
      object.title = state.record.title?.trim() || "未命名记录";
      if (state.record.isVoice === true) object.isVoice = true;
    } else {
      const ref: AgentObjectRef = { workspaceId: binding.workspaceId, scope: targetScope, kind: "file", id: String(id) };
      const page = await fileDocumentApi.versionsList(binding, { object: ref, limit: 1 });
      if (page.object.workspaceId !== binding.workspaceId || !ownsScope(page.object.scope) || page.object.id !== String(id) || page.object.kind !== "file")
        throw new Error("文件归属与请求范围不符");
      object.title = page.versions[0]?.name || object.title || "文件";
    }
  }
  assertCurrent(binding, await recordDocumentApi.bindingGet(input.workspaceRoot), input.signal);
  const scope = { workspaceId: binding.workspaceId, projectId: input.projectId };
  input.beforeOpen?.();
  const tabId = useProjectContentStore.getState().open(scope, object, { paneId: input.paneId, view: input.view });
  const result = { workspaceRoot: input.workspaceRoot, scope, tabId, object, view: input.view };
  if (input.reveal !== false) window.dispatchEvent(new CustomEvent(PROJECT_CONTENT_OPEN_EVENT, { detail: result }));
  return result;
}

export type ProjectSessionAction = DshSessionAction | { kind: "delete" };

/** Keep open content consistent with a successful native session operation. */
export async function manageProjectSession(input: {
  workspaceRoot: string; projectId: number | null; sessionId: string; action: ProjectSessionAction; signal?: AbortSignal;
}): Promise<string | null> {
  const binding = await recordDocumentApi.bindingGet(input.workspaceRoot);
  if (input.signal?.aborted) throw new DOMException("操作已取消", "AbortError");
  let result: string | null = null;
  if (input.action.kind === "delete") await dshAssistantApi.deleteSession(input.sessionId, input.projectId);
  else result = await dshAssistantApi.manageSession(input.sessionId, input.action, input.projectId);
  const renamed = input.action.kind === "rename"
    ? (await dshAssistantApi.sessions(input.projectId)).find(session => session.id === input.sessionId) : undefined;
  assertCurrent(binding, await recordDocumentApi.bindingGet(input.workspaceRoot), input.signal);
  const scope = { workspaceId: binding.workspaceId, projectId: input.projectId };
  const store = useProjectContentStore.getState();
  const tab = getContentLayout(store, scope).tabs
    .find(item => item.object.kind === "session" && item.object.id === input.sessionId);
  if (tab) {
    if (input.action.kind === "archive" || input.action.kind === "delete") store.close(scope, tab.id);
    else if (renamed) store.updateTitle(scope, tab.id, renamed.title);
  }
  return result;
}
