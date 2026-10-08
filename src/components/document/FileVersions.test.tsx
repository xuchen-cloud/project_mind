import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import FileVersions from "./FileVersions";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { desktopApi } from "../../services/desktopApi";
import { AgentApiError } from "../../services/agentApi";
import type { FileSourcePage, FileVersionPage } from "../../lib/file-types";
vi.mock("../../services/fileDocumentApi", () => ({ fileDocumentApi: { versionsList: vi.fn(), sourceRead: vi.fn(), restore: vi.fn() } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { confirm: vi.fn() } }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
const latest = { id: "10", versionNumber: 3, name: "notes.txt", createdAt: "2026-10-08T10:00:00Z", contentHash: "head", isCurrent: true };
const old = { ...latest, id: "9", versionNumber: 2, contentHash: "old", isCurrent: false };
const page: FileVersionPage = { object, currentVersionNumber: 3, currentContentHash: "head", versions: [latest, old], nextCursor: null };
const source = (versionNumber = 2, text = "old\ncommon\n"): FileSourcePage => ({ object, versionNumber, contentHash: versionNumber === 2 ? "old" : "head", title: "notes", byteLength: 12, format: "text", text, startChar: 0, endChar: text.length, totalChars: text.length, nextCursor: null, complete: true });
const props = { binding, object, title: "notes.txt", mimeType: "text/plain", onClose: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue(page);
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValue(source());
  vi.mocked(desktopApi.confirm).mockResolvedValue(true);
  vi.mocked(fileDocumentApi.restore).mockResolvedValue({ receipt: { documentId: 7, versionNumber: 4, contentHash: "old", noChange: false }, versionPath: null });
});
async function selectOld() { fireEvent.click(await screen.findByRole("button", { name: /^查看 v2 / })); await screen.findByText("old common", { exact: false }); }

it("loads metadata only on open and pages original text at the same immutable version and hash", async () => {
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValueOnce({ ...page, nextCursor: 2 }).mockResolvedValueOnce({ ...page, versions: [{ ...old, id: "8", versionNumber: 1 }], nextCursor: null });
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValueOnce({ ...source(), nextCursor: "fixed-v2-page", complete: false, totalChars: 9000 }).mockResolvedValueOnce({ ...source(2, "next page"), startChar: 4000 });
  render(<FileVersions {...props} />);
  await screen.findByRole("button", { name: /^查看 v2 / });
  expect(fileDocumentApi.sourceRead).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "加载更早版本" }));
  await screen.findByRole("button", { name: /^查看 v1 / });
  expect(fileDocumentApi.versionsList).toHaveBeenLastCalledWith(binding, { object, cursor: 2, limit: 50 });
  fireEvent.click(screen.getByRole("button", { name: /^查看 v2 / }));
  fireEvent.click(await screen.findByRole("button", { name: "下一页原文" }));
  await screen.findByText("next page");
  expect(fileDocumentApi.sourceRead).toHaveBeenLastCalledWith(binding, { object, versionNumber: 2, expectedContentHash: "old", cursor: "fixed-v2-page", budgetChars: 4000 });
  expect(screen.queryByText("old common", { exact: false })).not.toBeInTheDocument();
});
it("compares complete bounded actual snapshots and shows added, removed and unchanged lines", async () => {
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValueOnce(source()).mockResolvedValueOnce(source()).mockResolvedValueOnce(source(3, "new\ncommon\n"));
  render(<FileVersions {...props} />); await selectOld();
  fireEvent.click(screen.getByRole("button", { name: "与当前版本比较" }));
  expect(await screen.findByLabelText("新增行")).toHaveTextContent("new");
  expect(screen.getByLabelText("删除行")).toHaveTextContent("old");
  expect(screen.getByLabelText("未变化行")).toHaveTextContent("common");
  expect(fileDocumentApi.sourceRead).toHaveBeenLastCalledWith(binding, { object, versionNumber: 3, expectedContentHash: "head", budgetChars: 24000 });
});
it("does not present a truncated page as a complete text difference", async () => {
  vi.mocked(fileDocumentApi.sourceRead).mockResolvedValueOnce(source()).mockResolvedValueOnce({ ...source(), complete: false, totalChars: 50000, nextCursor: "next" }).mockResolvedValueOnce(source(3));
  render(<FileVersions {...props} />); await selectOld(); fireEvent.click(screen.getByRole("button", { name: "与当前版本比较" }));
  await screen.findByText(/尚未比较全文/); expect(screen.queryByLabelText("新增行")).not.toBeInTheDocument();
});
it("freezes restore baseline before confirmation, prevents duplicate submits, and refreshes actual receipt", async () => {
  let confirm!: (value: boolean) => void;
  vi.mocked(desktopApi.confirm).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  const onRestored = vi.fn(); render(<FileVersions {...props} onRestored={onRestored} />); await selectOld();
  fireEvent.click(screen.getByRole("button", { name: "恢复此版本" }));
  fireEvent.click(screen.getByRole("button", { name: "处理中…" }));
  expect(desktopApi.confirm).toHaveBeenCalledTimes(1);
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ ...page, currentVersionNumber: 4 });
  confirm(true);
  await waitFor(() => expect(fileDocumentApi.restore).toHaveBeenCalledTimes(1));
  expect(fileDocumentApi.restore).toHaveBeenCalledWith(binding, { object, versionId: "9", expectedVersionNumber: 3, expectedContentHash: "head" }, expect.any(String));
  await screen.findByText("已恢复为 v4。"); expect(onRestored).toHaveBeenCalledTimes(1);
  expect(fileDocumentApi.versionsList).toHaveBeenCalledTimes(2);
});
it("explains a CAS failure and never automatically retries or changes its baseline", async () => {
  vi.mocked(fileDocumentApi.restore).mockRejectedValue(new AgentApiError({ code: "REVISION_CONFLICT", message: "changed", retryable: false }));
  render(<FileVersions {...props} />); await selectOld(); fireEvent.click(screen.getByRole("button", { name: "恢复此版本" }));
  await screen.findByText(/当前版本已经变化/); expect(fileDocumentApi.restore).toHaveBeenCalledTimes(1);
  expect(fileDocumentApi.versionsList).toHaveBeenCalledTimes(1);
});
it("discards an old workspace source response and does not write after a switched confirmation", async () => {
  let resolveSource!: (value: FileSourcePage) => void;
  vi.mocked(fileDocumentApi.sourceRead).mockImplementationOnce(() => new Promise(resolve => { resolveSource = resolve; }));
  const view = render(<FileVersions {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: /^查看 v2 / }));
  view.rerender(<FileVersions {...props} binding={{ ...binding, generation: "next" }} />);
  resolveSource(source(2, "obsolete source"));
  await waitFor(() => expect(fileDocumentApi.versionsList).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("obsolete source")).not.toBeInTheDocument();
  await selectOld();
  let confirm!: (value: boolean) => void;
  vi.mocked(desktopApi.confirm).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "恢复此版本" }));
  view.rerender(<FileVersions {...props} binding={{ ...binding, generation: "third" }} />); confirm(true);
  await waitFor(() => expect(fileDocumentApi.versionsList).toHaveBeenCalledTimes(3));
  expect(fileDocumentApi.restore).not.toHaveBeenCalled();
});
it("shows binary metadata without fetching text and disables unknown-hash restore", async () => {
  vi.mocked(fileDocumentApi.versionsList).mockResolvedValue({ ...page, currentContentHash: null, versions: [{ ...old, name: "report.pdf", contentHash: null }] });
  render(<FileVersions {...props} mimeType="application/pdf" />);
  fireEvent.click(await screen.findByRole("button", { name: /^查看 v2 / }));
  expect(await screen.findByText(/此格式仅查看版本元数据/)).toBeInTheDocument();
  expect(fileDocumentApi.sourceRead).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "恢复此版本" })).toBeDisabled();
});

it("offers a fixed-version preview only to an explicit preview consumer without restoring bytes", async () => {
  const onPreviewVersion = vi.fn();
  const rendered = render(<FileVersions {...props} onPreviewVersion={onPreviewVersion} />);
  expect(screen.getByRole("button", { name: "查看此版本" })).toBeDisabled();
  await selectOld();
  fireEvent.click(screen.getByRole("button", { name: "查看此版本" }));
  expect(onPreviewVersion).toHaveBeenCalledWith(old);
  expect(fileDocumentApi.restore).not.toHaveBeenCalled();
  rendered.rerender(<FileVersions {...props} />);
  expect(screen.queryByRole("button", { name: "查看此版本" })).not.toBeInTheDocument();
});
