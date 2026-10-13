import type { AgentObjectRef, AgentWorkspaceBinding } from "../lib/agent-types";
import type { ContentObject, ContentPane, ContentScope, ContentView } from "../lib/project-content-layout";
import { useProjectContentStore } from "../state/project-content-store";
import { recordDocumentApi } from "./recordDocumentApi";
import { fileDocumentApi } from "./fileDocumentApi";
import { dshAssistantApi } from "./dshAssistantApi";

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
  projectId: number;
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

/** Verify ownership at the native boundary, then atomically deduplicate in the Project layout. */
export async function openProjectContent(input: ProjectContentOpenInput): Promise<ProjectContentOpenResult> {
  if (!Number.isSafeInteger(input.projectId) || input.projectId <= 0) throw new Error("无效项目身份");
  const binding = await recordDocumentApi.bindingGet(input.workspaceRoot);
  if (input.expectedBinding) assertCurrent(input.expectedBinding, binding, input.signal);
  const object: ContentObject = { kind: input.object.kind, id: input.object.id, title: input.object.title };
  if (object.kind === "session") {
    if (typeof object.id !== "string" || !object.id) throw new Error("无效会话身份");
    await dshAssistantApi.start(`${binding.workspaceId}:${binding.generation}`, input.projectId);
    const session = (await dshAssistantApi.sessions(input.projectId)).find(item => item.id === object.id);
    if (!session) throw new Error("会话不存在或不属于当前项目");
    object.title = session.title || "新会话";
  } else {
    const id = typeof object.id === "number" ? object.id : /^\d+$/u.test(object.id) ? Number(object.id) : NaN;
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("无效内容身份");
    object.id = id;
    if (object.kind === "record") {
      const state = await recordDocumentApi.editorGet(binding, { scope: { kind: "project", projectId: input.projectId }, recordId: id });
      if (state.head.target.scope.kind !== "project" || state.head.target.scope.projectId !== input.projectId || state.head.target.recordId !== id)
        throw new Error("记录归属与请求项目不符");
      object.title = state.record.title?.trim() || "未命名记录";
      if (state.record.isVoice === true) object.isVoice = true;
    } else {
      const ref: AgentObjectRef = { workspaceId: binding.workspaceId, scope: { kind: "project", projectId: input.projectId }, kind: "file", id: String(id) };
      const page = await fileDocumentApi.versionsList(binding, { object: ref, limit: 1 });
      if (page.object.workspaceId !== binding.workspaceId || page.object.scope.kind !== "project"
        || page.object.scope.projectId !== input.projectId || page.object.id !== String(id) || page.object.kind !== "file")
        throw new Error("文件归属与请求项目不符");
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
