import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import RecordHistoryDialog from "./RecordHistoryDialog";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import type { RecordVersion, RecordVersionSummary } from "../../lib/record-document-types";

vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: {
  versionsList: vi.fn(), capacity: vi.fn(), versionPreview: vi.fn(), versionGet: vi.fn(), versionsCompare: vi.fn(), editorsFlush: vi.fn(), restore: vi.fn(),
} }));
vi.mock("../rich-editor", () => ({ RichEditor: ({ defaultHtml, readOnly }: { defaultHtml: string; readOnly: boolean }) => <div data-testid="historic-body" data-readonly={readOnly}>{defaultHtml}</div> }));
const binding = { workspaceId: "workspace", generation: "opened" };
const target = { scope: { kind: "workspace" as const }, recordId: 7 };
const blockId = "1".repeat(32);
function version(number: number, text: string): RecordVersion {
  return { id: String(number).repeat(32), versionNumber: number, headRevision: number, titleSnapshot: "Historic title", origin: "manual", createdAt: "2026-10-01T00:00:00Z", actor: {}, operationId: `operation-${number}`, restoredFromVersionId: null,
    projection: { schemaVersion: 1, document: { type: "doc", content: [{ type: "paragraph", attrs: { blockId }, content: [{ type: "text", text }] }] }, html: `<p>${text}</p>`, markdown: text, text, codeLanguage: null, bodyHash: `hash-${number}` } };
}
function summary(item: RecordVersion): RecordVersionSummary { return { ...item, bodyHash: item.projection.bodyHash }; }
const old = version(1,"Earlier idea");
const latest = version(2,"Revised idea");
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(recordDocumentApi.versionsList).mockResolvedValue({ versions: [summary(latest),summary(old)], nextBefore: null });
  vi.mocked(recordDocumentApi.capacity).mockResolvedValue({ versionCount: 2, snapshotBytes: 1024, retainedAssetCount: 1 });
  vi.mocked(recordDocumentApi.versionPreview).mockImplementation(async (_binding,_target,id) => ({ version: id === old.id ? old : latest, html: id === old.id ? old.projection.html : latest.projection.html }));
  vi.mocked(recordDocumentApi.versionGet).mockResolvedValue(latest);
  vi.mocked(recordDocumentApi.versionsCompare).mockResolvedValue({ added: [], deleted: [], modified: [blockId], moved: [] });
  vi.mocked(recordDocumentApi.editorsFlush).mockResolvedValue({ head: { headRevision: 4 } } as never);
  vi.mocked(recordDocumentApi.restore).mockResolvedValue({} as never);
});
it("previews immutable versions, shows changed block text and restores only after explicit selection and confirmation", async () => {
  const onRestored = vi.fn();
  render(<RecordHistoryDialog binding={binding} target={target} onClose={vi.fn()} onRestored={onRestored} />);
  expect(await screen.findByTestId("historic-body")).toHaveTextContent("Revised idea");
  expect(screen.getByTestId("historic-body")).toHaveAttribute("data-readonly","true");
  expect(screen.getByRole("button",{ name: "恢复此版本" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{ name: /版本 1 · 手动编辑/ }));
  await waitFor(() => expect(screen.getByTestId("historic-body")).toHaveTextContent("Earlier idea"));
  fireEvent.click(screen.getByText("修改 1 块"));
  expect(screen.getByText("历史：Earlier idea")).toBeVisible();
  expect(screen.getByText("最新：Revised idea")).toBeVisible();
  fireEvent.click(screen.getByRole("button",{ name: "恢复此版本" }));
  expect(screen.getByText(/当前标题与标签会保留/)).toBeInTheDocument();
  expect(recordDocumentApi.restore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{ name: "确认恢复正文" }));
  await waitFor(() => expect(onRestored).toHaveBeenCalledOnce());
  expect(recordDocumentApi.restore).toHaveBeenCalledWith(binding,{ target, baseRevision: 4, versionId: old.id },expect.any(String));
});
it("loads older pages without repeating versions and keeps the body when a restore is blocked", async () => {
  const earlier = version(0,"First idea");
  vi.mocked(recordDocumentApi.versionsList).mockResolvedValueOnce({ versions: [summary(latest),summary(old)], nextBefore: 1 })
    .mockResolvedValueOnce({ versions: [summary(old),summary(earlier)], nextBefore: null });
  vi.mocked(recordDocumentApi.editorsFlush).mockRejectedValue(new Error("请先接受或取消记录中待确认的 AI 内容"));
  const onRestored = vi.fn();
  render(<RecordHistoryDialog binding={binding} target={target} onClose={vi.fn()} onRestored={onRestored} />);
  fireEvent.click(await screen.findByRole("button",{ name: "加载更早版本" }));
  await screen.findByRole("button",{ name: /版本 0 · 手动编辑/ });
  expect(screen.getAllByRole("button",{ name: /版本 1 · 手动编辑/ })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button",{ name: /版本 1 · 手动编辑/ }));
  await waitFor(() => expect(screen.getByTestId("historic-body")).toHaveTextContent("Earlier idea"));
  fireEvent.click(screen.getByRole("button",{ name: "恢复此版本" }));
  fireEvent.click(screen.getByRole("button",{ name: "确认恢复正文" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("待确认的 AI 内容");
  expect(screen.getByTestId("historic-body")).toHaveTextContent("Earlier idea");
  expect(recordDocumentApi.restore).not.toHaveBeenCalled();
  expect(onRestored).not.toHaveBeenCalled();
});
