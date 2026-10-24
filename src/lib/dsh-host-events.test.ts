import type { AgentSourceRef } from "./agent-types";
import { beforeEach, describe, expect, it } from "vitest";
import { requestDshFileReference, setDshWorkspaceRoot, useDshFileReferences, useDshSessionTitles } from "./dsh-host-events";
import { useAgentPanelStore } from "../state/agent-panel-store";
import { useFeedbackStore } from "../state/feedback-store";
beforeEach(() => { useAgentPanelStore.getState().clearWorkspace(); setDshWorkspaceRoot(null); useFeedbackStore.setState({ toasts: [] }); });
describe("DSH host integration boundaries", () => {
  it("opens and queues references with workspace/project ownership, clears on workspace change", () => {
    setDshWorkspaceRoot("/workspace"); requestDshFileReference(7, "src/main.ts");
    expect(useAgentPanelStore.getState().binding).toEqual({ workspaceRoot: "/workspace", scope: { kind: "project", projectId: 7 } });
    expect(useDshFileReferences.getState().pending).toEqual([expect.objectContaining({ workspaceRoot: "/workspace", projectId: 7, path: "src/main.ts" })]);
    setDshWorkspaceRoot("/other"); expect(useDshFileReferences.getState().pending).toEqual([]);
  });
  it("queues a second Project independently of a running Project", () => {
    setDshWorkspaceRoot("/workspace"); useAgentPanelStore.getState().openPanel("/workspace", { kind: "project", projectId: 1 }); useAgentPanelStore.getState().setRunBusy("/workspace", 1, true);
    requestDshFileReference(2, "file.ts"); expect(useDshFileReferences.getState().pending).toEqual([expect.objectContaining({ projectId: 2, path: "file.ts" })]);
    expect(useAgentPanelStore.getState().runningBinding?.scope).toEqual({ kind: "project", projectId: 1 });
  });
  it("reports missing workspace", () => { requestDshFileReference(1, "file.ts"); expect(useFeedbackStore.getState().toasts[0]?.tone).toBe("error"); });
});

it('addresses an explicit Session reference without sending it to the legacy panel', () => {
  setDshWorkspaceRoot('/workspace');
  requestDshFileReference(7, 'first.md', 'session-a');
  requestDshFileReference(7, 'second.md', 'session-b');
  expect(useAgentPanelStore.getState().open).toBe(false);
  expect(useDshFileReferences.getState().pending.map(item => [item.sessionId, item.path]))
    .toEqual([['session-a', 'first.md'], ['session-b', 'second.md']]);
});

it('preserves the fixed File version for the selected Session', () => {
  setDshWorkspaceRoot('/workspace');
  const source: AgentSourceRef = { object: { workspaceId: 'ws', scope: { kind: 'project', projectId: 7 }, kind: 'file', id: '7:9' }, revision: 'sha256:fixed', fileVersion: 3, recordVersion: null, blockId: null, locator: null, title: 'old.md', excerpt: '' };
  requestDshFileReference(7, 'renamed.md', 'session-a', source);
  expect(useDshFileReferences.getState().pending[0]).toMatchObject({ sessionId: 'session-a', path: 'renamed.md', sourceRef: source });
});

it("bridges exact Session facts and clears them when the workspace closes or a project releases", () => {
  const emit = (runningBySession: Record<string, boolean>) => window.dispatchEvent(new CustomEvent("mind:dsh-session-runs", { detail: { projectId: 7, runningBySession } }));
  setDshWorkspaceRoot("/workspace"); emit({ alpha: true, beta: false });
  expect(Object.values(useAgentPanelStore.getState().sessionsByProject)).toEqual([{ alpha: true, beta: false }]);
  emit({}); expect(useAgentPanelStore.getState().sessionsByProject).toEqual({});
  emit({ alpha: true }); setDshWorkspaceRoot("/other");
  expect(useAgentPanelStore.getState().sessionsByProject).toEqual({});
  setDshWorkspaceRoot(null); emit({ ignored: true });
  expect(useAgentPanelStore.getState().sessionsByProject).toEqual({});
});

it("keeps null Workspace busy and session facts separate from a running Project and clears both on close", () => {
  setDshWorkspaceRoot("/workspace");
  for (const projectId of [null, 7]) {
    window.dispatchEvent(new CustomEvent("mind:dsh-project-busy", { detail: { projectId, busy: true } }));
    window.dispatchEvent(new CustomEvent("mind:dsh-session-runs", { detail: { projectId, runningBySession: { sameId: true } } }));
  }
  expect(Object.values(useAgentPanelStore.getState().runsByProject).map(run => run.scope)).toEqual([{ kind: "workspace" }, { kind: "project", projectId: 7 }]);
  expect(Object.keys(useAgentPanelStore.getState().sessionsByProject)).toHaveLength(2);
  window.dispatchEvent(new CustomEvent("mind:dsh-project-busy", { detail: { projectId: null, busy: false } }));
  expect(useAgentPanelStore.getState().runningBinding?.scope).toEqual({ kind: "project", projectId: 7 });
  setDshWorkspaceRoot(null);
  expect(useAgentPanelStore.getState().sessionsByProject).toEqual({});
  expect(useAgentPanelStore.getState().runsByProject).toEqual({});
});

it("retains title snapshots by Project, replaces disposed catalogs, and clears them on Workspace changes", () => {
  const emit = (projectId: number | null, titlesBySession: Record<string, string>) => window.dispatchEvent(new CustomEvent("mind:dsh-session-titles", { detail: { projectId, titlesBySession } }));
  emit(7, { ignored: "关闭后忽略" });
  expect(useDshSessionTitles.getState().byProject).toEqual({});
  setDshWorkspaceRoot("/workspace");
  emit(7, { sameId: "项目七标题" }); emit(8, { sameId: "项目八标题" }); emit(null, { sameId: "工作区会话" });
  expect(useDshSessionTitles.getState()).toEqual({ workspaceRoot: "/workspace", byProject: { 7: { sameId: "项目七标题" }, 8: { sameId: "项目八标题" }, null: { sameId: "工作区会话" } } });
  emit(7, {});
  expect(useDshSessionTitles.getState().byProject).toEqual({ 7: {}, 8: { sameId: "项目八标题" }, null: { sameId: "工作区会话" } });
  setDshWorkspaceRoot("/other");
  expect(useDshSessionTitles.getState()).toEqual({ workspaceRoot: "/other", byProject: {} });
  setDshWorkspaceRoot(null); emit(8, { ignored: "关闭后忽略" });
  expect(useDshSessionTitles.getState()).toEqual({ workspaceRoot: null, byProject: {} });
});
