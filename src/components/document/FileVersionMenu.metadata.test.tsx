import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../../services/desktopApi";
import { fileDocumentApi } from "../../services/fileDocumentApi";
import { queryKeys } from "../../lib/queryKeys";
import { FileVersionMenu } from "./FileVersionMenu";

vi.mock("../../services/desktopApi", () => ({ desktopApi: { command: vi.fn() } }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
const version = { id: "12", versionNumber: 2, name: "physical.txt", createdAt: "2026-11-10", contentHash: "retained-hash", isCurrent: false,
  displayName: "评审版", isImportant: true, metadataRevision: 3 };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(desktopApi.command).mockImplementation(async (command, args) => {
    const input = args!.input as { requestId: string; data: { displayName?: string | null; isImportant?: boolean } };
    const data = command === "file_versions_list" ? { object, currentVersionNumber: 3, currentContentHash: "head-hash", versions: [version], nextCursor: null }
      : command === "file_versions_get" ? { object, currentVersionNumber: 3, currentContentHash: "head-hash", version }
      : { object, versionId: version.id, displayName: input.data.displayName, isImportant: input.data.isImportant, metadataRevision: 4 };
    return { apiVersion: 1, requestId: input.requestId, ok: true, data };
  });
});
async function mount(parentClick = vi.fn()) {
  // Follow the production projection path: both existing parent menus forward these versions.
  const page = await fileDocumentApi.versionsList(binding, { object, limit: 50 }, "list");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSelect = vi.fn();
  const view = render(<div onClick={parentClick}><FileVersionMenu label="文件版本" triggerLabel="v3" versions={page.versions} onSelect={onSelect} /></div>, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { ...view, client, onSelect, parentClick };
}
it("edits real retained-version metadata from the history menu using its frozen owner and revision", async () => {
  const { client, onSelect } = await mount();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  fireEvent.click(screen.getByRole("button", { name: "文件版本" }));
  expect(screen.getByText("V2（评审版）")).toBeVisible();
  expect(screen.getByRole("menuitemradio", { name: /重要版本/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑 V2 标记" }));
  const editor = within(screen.getByRole("dialog", { name: "编辑版本标记" }));
  fireEvent.change(editor.getByRole("textbox", { name: "自定义版本名称" }), { target: { value: " 新名称 " } });
  fireEvent.click(editor.getByRole("checkbox", { name: "重要版本" }));
  fireEvent.click(editor.getByRole("button", { name: "保存" }));
  expect(await editor.findByRole("status")).toHaveTextContent("已保存");
  expect(desktopApi.command).toHaveBeenLastCalledWith("file_version_metadata_update", { input: { binding, requestId: expect.any(String), data: {
    object, versionId: "12", expectedMetadataRevision: 3, displayName: "新名称", isImportant: false,
  } } });
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: queryKeys.documentVersions(7) });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(editor.getByRole("button", { name: "完成" }));
  fireEvent.click(screen.getByRole("button", { name: "文件版本" }));
  expect(screen.getByText("V2（新名称）")).toBeVisible();
  expect(screen.queryByRole("menuitemradio", { name: /重要版本/ })).not.toBeInTheDocument();
  expect(vi.mocked(desktopApi.command).mock.calls.map(call => call[0])).toEqual(["file_versions_list", "file_version_metadata_update"]);
});

it("keeps a conflicting draft blocked until the user reads the latest metadata and explicitly saves again", async () => {
  const { client } = await mount();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const native = vi.mocked(desktopApi.command).getMockImplementation()!;
  let updates = 0;
  vi.mocked(desktopApi.command).mockImplementation(async (command, args) => {
    const { requestId } = args!.input as { requestId: string };
    if (command === "file_version_metadata_update" && ++updates === 1) return { apiVersion: 1, requestId, ok: false,
      error: { code: "REVISION_CONFLICT", message: "版本标记已被其他窗口修改", retryable: false, details: { metadataRevision: 5 } } };
    if (command === "file_versions_get") return { apiVersion: 1, requestId, ok: true,
      data: { object, currentVersionNumber: 3, currentContentHash: "head-hash", version: { ...version, displayName: "其他窗口名称", isImportant: false, metadataRevision: 5 } } };
    return native(command, args);
  });
  fireEvent.click(screen.getByRole("button", { name: "文件版本" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑 V2 标记" }));
  const input = screen.getByRole("textbox", { name: "自定义版本名称" });
  fireEvent.change(input, { target: { value: "保留的输入" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("版本标记已被其他窗口修改");
  expect(input).toHaveValue("保留的输入");
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(updates).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "读取最新标记" }));
  expect(await screen.findByRole("status")).toHaveTextContent("最新名称：其他窗口名称；普通版本");
  expect(input).toHaveValue("保留的输入");
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(screen.getByRole("button", { name: "保存" })).toBeEnabled();
  expect(updates).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已保存"));
  expect(desktopApi.command).toHaveBeenLastCalledWith("file_version_metadata_update", { input: { binding, requestId: expect.any(String),
    data: { object, versionId: "12", expectedMetadataRevision: 5, displayName: "保留的输入", isImportant: true } } });
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: queryKeys.documentVersions(7) });
});

it("keeps failed edits and uses the confirmed metadata revision for subsequent explicit changes", async () => {
  const { client } = await mount();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const native = vi.mocked(desktopApi.command).getMockImplementation()!;
  vi.mocked(desktopApi.command).mockImplementationOnce(async (_command, args) => ({ apiVersion: 1,
    requestId: (args!.input as { requestId: string }).requestId, ok: false,
    error: { code: "SCOPE_DENIED", message: "当前 File 不允许修改", retryable: false } }));
  fireEvent.click(screen.getByRole("button", { name: "文件版本" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑 V2 标记" }));
  const input = screen.getByRole("textbox", { name: "自定义版本名称" });
  fireEvent.change(input, { target: { value: "保留名称" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("当前 File 不允许修改");
  expect(input).toHaveValue("保留名称");
  expect(screen.getByRole("checkbox")).toBeChecked();
  expect(invalidate).not.toHaveBeenCalled();
  vi.mocked(desktopApi.command).mockImplementation(native);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("status");
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已保存");
  expect(screen.getByText("V2")).toBeVisible();
  expect(desktopApi.command).toHaveBeenLastCalledWith("file_version_metadata_update", { input: { binding, requestId: expect.any(String),
    data: { object, versionId: "12", expectedMetadataRevision: 4, displayName: null, isImportant: false } } });
  expect(invalidate).toHaveBeenCalledTimes(2);
});

it.each(["workspace", "generation", "owner", "file"])("ignores old save completion when the %s changes with the same retained version ID", async change => {
  const { client, rerender, onSelect, parentClick } = await mount();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const native = vi.mocked(desktopApi.command).getMockImplementation()!;
  let finish!: (value: unknown) => void;
  let oldRequestId = "";
  vi.mocked(desktopApi.command).mockImplementationOnce(async (_command, args) => {
    oldRequestId = (args!.input as { requestId: string }).requestId;
    return new Promise(resolve => { finish = resolve; });
  });
  fireEvent.click(screen.getByRole("button", { name: "文件版本" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑 V2 标记" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "旧输入" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(oldRequestId).not.toBe(""));
  const nextBinding = { ...binding, workspaceId: change === "workspace" ? "other" : binding.workspaceId, generation: change === "generation" ? "g2" : binding.generation };
  const nextObject = { ...object, workspaceId: nextBinding.workspaceId, scope: change === "owner" ? { kind: "project" as const, projectId: 8 } : object.scope,
    id: change === "file" ? "9" : object.id };
  const nextVersion = { ...version, displayName: "新对象", metadataTarget: { binding: nextBinding, object: nextObject } };
  rerender(<div onClick={parentClick}><FileVersionMenu label="文件版本" triggerLabel="v3" versions={[nextVersion]} onSelect={onSelect} /></div>);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "文件版本" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑 V2 标记" }));
  await act(async () => finish({ apiVersion: 1, requestId: oldRequestId, ok: true,
    data: { object, versionId: "12", displayName: "旧输入", isImportant: true, metadataRevision: 4 } }));
  expect(screen.getByRole("textbox")).toHaveValue("新对象");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(invalidate).not.toHaveBeenCalled();
  vi.mocked(desktopApi.command).mockImplementation(native);
});

it("contains metadata-dialog clicks so sidebar content is not opened while editing labels", async () => {
  const { parentClick } = await mount();
  fireEvent.click(screen.getByRole("button", { name: "文件版本" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑 V2 标记" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("status");
  fireEvent.click(screen.getByText("V2（评审版）"));
  expect(parentClick).not.toHaveBeenCalled();
});
