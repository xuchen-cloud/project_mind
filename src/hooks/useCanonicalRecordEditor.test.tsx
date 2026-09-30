import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useCanonicalRecordEditor } from "./useCanonicalRecordEditor";
import { agentApi } from "../services/agentApi";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { RecordSaveCoordinator } from "../lib/record-save-coordinator";
import type { RecordEditorState, RecordTarget } from "../lib/record-document-types";

vi.mock("../services/agentApi", () => ({ agentApi: { statusGet: vi.fn() } }));
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { editorGet: vi.fn(), checkpoint: vi.fn() } }));
const binding = { workspaceId: "workspace-id", generation: "opened-1" };
const target: RecordTarget = { scope: { kind: "project", projectId: 1 }, recordId: 7 };
const document = { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "1".repeat(32) } }] };
const editor: RecordEditorState = {
  head: { target, headRevision: 4, editSessionId: null, checkpointDueAt: null,
    projection: { schemaVersion: 1, document, html: "<p data-block-id='11111111111111111111111111111111'></p>", markdown: "", text: "", bodyHash: "sha256:fixture", codeLanguage: null } },
  metadata: { title: "Title", tagIds: [], revision: "metadata-1", updatedAt: "now" },
  record: { id: 7, projectId: 1, title: "Title", contentHtml: "<p></p>", contentMarkdown: "", tags: [], createdAt: "now", updatedAt: "now" },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentApi.statusGet).mockResolvedValue({ binding, runtimeAvailable: false, bridgeAvailable: false, capabilities: [] });
  vi.mocked(recordDocumentApi.editorGet).mockResolvedValue(editor);
});

it("blocks capture until a bound canonical head is loaded and advances on its own acknowledged save", async () => {
  const coordinator = new RecordSaveCoordinator({ workspaceKey: "/workspace", adapter: { persist: async () => ({ updatedAt: "saved", headRevision: 5 }) } });
  const { result } = renderHook(() => useCanonicalRecordEditor({ target, coordinator, enabled: true }));
  expect(result.current.capture(document)).toBeNull();
  await waitFor(() => expect(result.current.ready).toBe(true));
  expect(recordDocumentApi.editorGet).toHaveBeenCalledWith(binding, target);
  expect(result.current.recordKey).toBe("workspace-id:project:1:7");
  const first = result.current.capture(document)!;
  expect(first).toMatchObject({ binding, baseRevision: 4, metadataBase: editor.metadata });
  await act(async () => {
    coordinator.submit({ scope: "project", workspaceKey: "/workspace", projectId: 1, recordId: 7, title: "Title", tagIds: [], defaultCodeLanguage: null, committedContent: { html: "", text: "", markdown: "" }, canonicalBody: first });
    await coordinator.flush();
  });
  expect(result.current.capture(document)?.baseRevision).toBe(5);
});

it("does not load an unbound record and retains a conversion diagnostic for read-only fallback", async () => {
  vi.mocked(agentApi.statusGet).mockResolvedValue({ binding: null, runtimeAvailable: false, bridgeAvailable: false, capabilities: [] });
  const coordinator = new RecordSaveCoordinator({ adapter: { persist: async () => ({ updatedAt: "saved" }) } });
  const { result, rerender } = renderHook(({ enabled }) => useCanonicalRecordEditor({ target, coordinator, enabled }), { initialProps: { enabled: true } });
  await waitFor(() => expect(result.current.error).toBeTruthy());
  expect(result.current.ready).toBe(false);
  expect(recordDocumentApi.editorGet).not.toHaveBeenCalled();
  rerender({ enabled: false });
  expect(result.current.capture(document)).toBeNull();
});

it("ignores a delayed response after the editor identity changes", async () => {
  let resolve!: (state: RecordEditorState) => void;
  vi.mocked(recordDocumentApi.editorGet).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const coordinator = new RecordSaveCoordinator({ adapter: { persist: async () => ({ updatedAt: "saved" }) } });
  const { result, rerender } = renderHook(({ currentTarget }) => useCanonicalRecordEditor({ target: currentTarget, coordinator, enabled: true }), { initialProps: { currentTarget: target } });
  await waitFor(() => expect(recordDocumentApi.editorGet).toHaveBeenCalledTimes(1));
  const secondTarget = { ...target, recordId: 8 };
  vi.mocked(recordDocumentApi.editorGet).mockResolvedValue({ ...editor, head: { ...editor.head, target: secondTarget } });
  rerender({ currentTarget: secondTarget });
  await waitFor(() => expect(result.current.state?.head.target.recordId).toBe(8));
  await act(async () => { resolve(editor); });
  expect(result.current.state?.head.target.recordId).toBe(8);
});

it("checkpoints the acknowledged head after flushing the record queue", async () => {
  const coordinator = new RecordSaveCoordinator({ workspaceKey: "/workspace", adapter: { persist: async (snapshot) => ({ updatedAt: "saved", headRevision: snapshot.canonicalBody!.baseRevision + 1 }) } });
  const { result } = renderHook(() => useCanonicalRecordEditor({ target, coordinator, enabled: true }));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(async () => {
    coordinator.submit({ scope: "project", workspaceKey: "/workspace", projectId: 1, recordId: 7,
      title: "Title", tagIds: [], defaultCodeLanguage: null, committedContent: { html: "", text: "", markdown: "" }, canonicalBody: result.current.capture(document)! });
    await result.current.checkpoint("leave_editor");
  });
  expect(recordDocumentApi.checkpoint).toHaveBeenCalledWith(binding, { target, baseRevision: 5, reason: "leave_editor" });
});
