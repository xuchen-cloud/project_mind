import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { DocumentRecord, WorkspaceStatusSnapshot } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { commitDocumentVersion } from "../../services/documentVersionAction";
import FileVersionHistory from "./FileVersionHistory";
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/documentVersionAction", () => ({ commitDocumentVersion: vi.fn() }));
vi.mock("./FileVersions", () => ({ default: ({ binding, object, onRestored, onRegisterCurrent }: {
  binding: { generation: string }; object: { id: string }; onRestored: () => Promise<unknown>; onRegisterCurrent: (revision: number) => Promise<unknown>;
}) => <div><span>{`${binding.generation}:${object.id}`}</span><button onClick={() => void onRestored()}>restored</button><button onClick={() => void onRegisterCurrent(7)}>register</button></div> }));
const document: DocumentRecord = { id: 12, projectId: 3, name: "a.txt", baseName: "a.txt", originalPath: "/original", managedPath: "/managed", historyDirPath: "/history", storageMode: "managed", mimeType: "text/plain", isStarred: false, currentVersionNumber: 2, versionCount: 2, health: "normal", tags: [], createdAt: "now", updatedAt: "now" };
const status: WorkspaceStatusSnapshot = { currentWorkspace: { rootPath: "/workspace", metadataPath: "/workspace/meta", displayName: "work", createdAt: "now" }, recentWorkspaces: [], aiSecretsUnlocked: true, securityMode: "open" };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ workspaceId: "w", generation: "opened" }); });
it("invalidates actual project, search and legacy version list after restore and reuses registration with displayed head", async () => {
  const client = new QueryClient(); client.setQueryData(queryKeys.workspaceStatus, status);
  const invalidated = vi.spyOn(client, "invalidateQueries");
  render(<QueryClientProvider client={client}><FileVersionHistory document={document} onClose={vi.fn()} /></QueryClientProvider>);
  await screen.findByText("opened:12"); fireEvent.click(screen.getByText("restored"));
  await waitFor(() => expect(invalidated).toHaveBeenCalledWith({ queryKey: queryKeys.documentVersions(12) }));
  expect(invalidated).toHaveBeenCalledWith({ queryKey: queryKeys.projectPage(3) });
  expect(invalidated).toHaveBeenCalledWith({ queryKey: ["search"] });
  fireEvent.click(screen.getByText("register"));
  expect(commitDocumentVersion).toHaveBeenCalledWith({ documentId: 12, projectId: 3, managedPath: "/managed", expectedVersionNumber: 7 });
});
it("does not mount history from an old binding response after Workspace switches", async () => {
  let oldBinding!: (value: { workspaceId: string; generation: string }) => void;
  vi.mocked(recordDocumentApi.bindingGet).mockImplementationOnce(() => new Promise(resolve => { oldBinding = resolve; }));
  const client = new QueryClient(); client.setQueryData(queryKeys.workspaceStatus, status);
  render(<QueryClientProvider client={client}><FileVersionHistory document={document} onClose={vi.fn()} /></QueryClientProvider>);
  await waitFor(() => expect(recordDocumentApi.bindingGet).toHaveBeenCalledTimes(1));
  client.setQueryData(queryKeys.workspaceStatus, { ...status, currentWorkspace: { ...status.currentWorkspace!, rootPath: "/next" } });
  await screen.findByText("opened:12"); oldBinding({ workspaceId: "old", generation: "obsolete" });
  expect(screen.queryByText("obsolete:12")).not.toBeInTheDocument();
});
