import type { AgentSourceRef } from "./agent-types";
import { beforeEach, describe, expect, it } from "vitest";
import { requestDshFileReference, setDshWorkspaceRoot, useDshFileReferences } from "./dsh-host-events";
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
