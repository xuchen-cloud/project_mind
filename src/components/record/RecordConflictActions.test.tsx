import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { RecordConflictActions, type RecordConflictDraft } from "./RecordConflictActions";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { fixtureEditorState } from "../../test/recordDocumentFixture";

vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { editorGet: vi.fn(), bindingGet: vi.fn(), create: vi.fn() } }));
vi.mock("../rich-editor", () => ({ RichEditor: ({ defaultHtml, readOnly }: { defaultHtml: string; readOnly: boolean }) => <div data-testid="compared-body" data-readonly={readOnly}>{defaultHtml}</div> }));
const binding = { workspaceId: "workspace", generation: "opened" };
const target = { scope: { kind: "workspace" as const }, recordId: 7 };
const record = { id: 7, title: "Saved title", contentHtml: "<p>Saved body</p>", contentMarkdown: "Saved body", tags: [], createdAt: "now", updatedAt: "now" };
const incoming = fixtureEditorState(target, record);
const draft: RecordConflictDraft = { title: "Draft title", tagIds: [], codeLanguage: "python", html: "<p>Draft body</p>", document: { ...incoming.head.projection.document, content: [{ ...incoming.head.projection.document.content![0], content: [{ type: "text", text: "Draft body" }] }] } };
const props = { binding, target, incoming, workspaceRoot: "/workspace", availableTags: [], getDraft: () => draft, pendingReviewCount: () => 0 };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(recordDocumentApi.editorGet).mockResolvedValue(incoming);
  vi.mocked(recordDocumentApi.create).mockResolvedValue(fixtureEditorState({ ...target, recordId: 8 }, { ...record, id: 8 }));
});
it("compares the latest saved body with committed draft content without writing anything", async () => {
  render(<RecordConflictActions {...props} onReload={vi.fn()} onSavedAs={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "查看差异" }));
  expect(await screen.findByRole("dialog", { name: "记录差异" })).toBeInTheDocument();
  expect(screen.getByText("修改 1 块")).toBeInTheDocument();
  fireEvent.click(screen.getByText("修改 1 块"));
  expect(screen.getByText("已保存：Saved body")).toBeInTheDocument();
  expect(screen.getByText("草稿：Draft body")).toBeInTheDocument();
  expect(screen.getByText("Saved title")).toBeInTheDocument();
  expect(screen.getByText("Draft title")).toBeInTheDocument();
  expect(screen.getAllByTestId("compared-body").every((body) => body.dataset.readonly === "true")).toBe(true);
  expect(recordDocumentApi.create).not.toHaveBeenCalled();
});
it("requires an explicit discard confirmation and retains unresolved AI candidates", async () => {
  const onReload = vi.fn();
  let pending = 1;
  render(<RecordConflictActions {...props} pendingReviewCount={() => pending} onReload={onReload} onSavedAs={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "重载" }));
  const confirm = await screen.findByRole("button", { name: "确认放弃草稿并重载" });
  expect(onReload).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  expect(await screen.findByText(/候选和草稿都已保留/)).toBeInTheDocument();
  expect(recordDocumentApi.editorGet).not.toHaveBeenCalled();
  pending = 0;
  fireEvent.click(confirm);
  await waitFor(() => expect(onReload).toHaveBeenCalledOnce());
  expect(recordDocumentApi.editorGet).toHaveBeenCalledWith(binding, target);
});
it("copies the latest committed draft and retains the created identity if queue resolution must be retried", async () => {
  const onSavedAs = vi.fn().mockRejectedValueOnce(new Error("旧记录仍在保存")).mockResolvedValue(undefined);
  render(<RecordConflictActions {...props} onReload={vi.fn()} onSavedAs={onSavedAs} />);
  fireEvent.click(screen.getByRole("button", { name: "另存 Record" }));
  const confirm = await screen.findByRole("button", { name: "确认另存 Record" });
  fireEvent.click(confirm);
  await screen.findByText("旧记录仍在保存");
  expect(recordDocumentApi.create).toHaveBeenCalledWith(binding, {
    scope: target.scope, title: draft.title, tagIds: [], document: draft.document, codeLanguage: "python",
  }, expect.any(String));
  fireEvent.click(confirm);
  await waitFor(() => expect(onSavedAs).toHaveBeenCalledTimes(2));
  expect(recordDocumentApi.create).toHaveBeenCalledOnce();
});
it("closes a hidden resident page's dialog and does not resolve its draft after a late creation reply", async () => {
  let complete!: (state: typeof incoming) => void;
  vi.mocked(recordDocumentApi.create).mockReturnValue(new Promise((resolve) => { complete = resolve; }));
  const onSavedAs = vi.fn();
  const callbacks = { onReload: vi.fn(), onSavedAs };
  const view = render(<RecordConflictActions {...props} {...callbacks} />);
  fireEvent.click(screen.getByRole("button", { name: "另存 Record" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认另存 Record" }));
  await waitFor(() => expect(recordDocumentApi.create).toHaveBeenCalledOnce());
  view.rerender(<RecordConflictActions {...props} {...callbacks} visible={false} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  view.rerender(<RecordConflictActions {...props} {...callbacks} visible />);
  await act(async () => { complete(incoming); });
  expect(onSavedAs).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "另存 Record" }));
  fireEvent.click(await screen.findByRole("button", { name: "确认另存 Record" }));
  await waitFor(() => expect(onSavedAs).toHaveBeenCalledOnce());
  expect(recordDocumentApi.create).toHaveBeenCalledOnce();
});
