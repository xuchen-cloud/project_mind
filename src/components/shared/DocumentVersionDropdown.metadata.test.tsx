import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DocumentVersionDropdown } from "../document/DocumentSharedComponents";
import { desktopApi } from "../../services/desktopApi";
import { queryKeys } from "../../lib/queryKeys";
import type { DocumentRecord } from "../../lib/types";

vi.mock("../../services/desktopApi", () => ({ desktopApi: { command: vi.fn() } }));
const binding = { workspaceId: "real-workspace", generation: "opened-1" };
beforeEach(() => vi.resetAllMocks());

it.each([null, 2])("edits labels through the production dropdown for File owner %s without selecting or saving content", async projectId => {
  const object = { workspaceId: binding.workspaceId, scope: projectId === null ? { kind: "workspace" as const } : { kind: "project" as const, projectId }, kind: "file" as const, id: "7" };
  let retained = { id: "12", versionNumber: 2, name: "physical.txt", createdAt: "2026-11-10", contentHash: "h2", isCurrent: true,
    displayName: "自定义名称" as string | null, isImportant: true, metadataRevision: 3 };
  vi.mocked(desktopApi.command).mockImplementation(async (command, args) => {
    const { requestId, data } = args!.input as { requestId: string; data?: { displayName: string | null; isImportant: boolean } };
    let result;
    if (command === "record_workspace_binding_get") result = binding;
    else if (command === "file_versions_list") result = { object, currentVersionNumber: 2, currentContentHash: "h2", versions: [retained], nextCursor: null };
    else if (command === "file_version_metadata_update") {
      retained = { ...retained, ...data!, metadataRevision: 4 };
      result = { object, versionId: retained.id, displayName: retained.displayName, isImportant: retained.isImportant, metadataRevision: retained.metadataRevision };
    } else throw new Error(`Unexpected command: ${command}`);
    return { apiVersion: 1, requestId, ok: true, data: result };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/actual-workspace" } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onOpenVersion = vi.fn();
  const document: DocumentRecord = { id: 7, projectId, name: "physical.txt", baseName: "physical", mimeType: "text/plain", managedPath: "/owner/physical.txt",
    originalPath: "", historyDirPath: "", storageMode: "managed", isStarred: false, currentVersionNumber: 2, versionCount: 2, health: "normal", tags: [], createdAt: "", updatedAt: "" };
  render(<QueryClientProvider client={client}><DocumentVersionDropdown document={document} onOpenVersion={onOpenVersion} /></QueryClientProvider>);
  expect(desktopApi.command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "选择 physical 的版本" }));
  expect(await screen.findByRole("menuitemradio", { name: /自定义名称.*重要版本/ })).toHaveTextContent("V2（自定义名称）");
  fireEvent.click(screen.getByRole("menuitem", { name: "编辑 V2 标记" }));
  fireEvent.change(screen.getByRole("textbox", { name: "自定义版本名称" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "重要版本" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已保存");
  expect(desktopApi.command).toHaveBeenLastCalledWith("file_version_metadata_update", { input: { binding, requestId: expect.any(String),
    data: { object, versionId: "12", expectedMetadataRevision: 3, displayName: null, isImportant: false } } });
  expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: queryKeys.documentVersions(7) });
  expect(onOpenVersion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "完成" }));
  fireEvent.click(screen.getByRole("button", { name: "选择 physical 的版本" }));
  await waitFor(() => expect(screen.getByRole("menuitemradio", { name: "v2" })).toHaveTextContent("V2"));
  expect(screen.queryByText("physical.txt")).not.toBeInTheDocument();
  expect(vi.mocked(desktopApi.command).mock.calls.every(call => ["record_workspace_binding_get", "file_versions_list", "file_version_metadata_update"].includes(call[0]))).toBe(true);
});
