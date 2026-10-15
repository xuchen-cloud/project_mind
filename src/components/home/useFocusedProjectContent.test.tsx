import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { queryKeys } from "../../lib/queryKeys";
import { useProjectContentStore } from "../../state/project-content-store";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { useFocusedProjectContent } from "./useFocusedProjectContent";

vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { resolve: vi.fn() } }));
const binding = { workspaceId: "native-workspace", generation: "1" };
const scope = { workspaceId: binding.workspaceId, projectId: 7 };
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.projectContentBinding("/workspace"), binding);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(({ root, projectId }) => useFocusedProjectContent(root, projectId), { wrapper, initialProps: { root: "/workspace", projectId: 7 } });
}
beforeEach(() => {
  vi.resetAllMocks();
  useProjectContentStore.setState({ layouts: {} });
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectFileApi.resolve).mockImplementation(async (_binding, object) => ({ object, relativePath: "generated/result.txt", name: "result.txt", versionNumber: 1, contentHash: null, state: "ready", reason: null }));
});
it("follows only the focused pane across records, sessions, files and homepage", async () => {
  const store = useProjectContentStore.getState();
  const record = store.open(scope, { kind: "record", id: 12, title: "Record" });
  store.split(scope);
  store.open(scope, { kind: "session", id: "alpha", title: "Session" }, { paneId: "left" });
  const view = setup();
  expect(view.result.current.activeSessionId).toBe("alpha");
  expect(view.result.current.activeRecordId).toBeNull();
  act(() => store.select(scope, "right", record));
  expect(view.result.current.activeRecordId).toBe(12);
  expect(view.result.current.activeSessionId).toBeNull();
  act(() => { store.open(scope, { kind: "file", id: 42, title: "File" }); });
  expect(view.result.current.activeRecordId).toBeNull();
  expect(view.result.current.activeFileId).toBe(42);
  await waitFor(() => expect(view.result.current.activeRelativePath).toBe("generated/result.txt"));
  expect(projectFileApi.resolve).toHaveBeenCalledWith(binding, { workspaceId: binding.workspaceId, scope: { kind: "project", projectId: 7 }, kind: "file", id: "42" });
  act(() => store.selectHome(scope));
  expect(view.result.current).toMatchObject({ activeRecordId: null, activeSessionId: null, activeFileId: null, activeRelativePath: null });
  expect(recordDocumentApi.bindingGet).not.toHaveBeenCalled();
});
it("isolates project and workspace identity and ignores stale path resolution", async () => {
  const store = useProjectContentStore.getState();
  store.open(scope, { kind: "file", id: 42, title: "File" });
  let resolve!: (value: Awaited<ReturnType<typeof projectFileApi.resolve>>) => void;
  vi.mocked(projectFileApi.resolve).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const view = setup();
  await waitFor(() => expect(projectFileApi.resolve).toHaveBeenCalledOnce());
  view.rerender({ root: "/workspace", projectId: 8 });
  expect(view.result.current.activeFileId).toBeNull();
  await act(async () => resolve({ object: { workspaceId: binding.workspaceId, scope: { kind: "project", projectId: 7 }, kind: "file", id: "42" }, relativePath: "old.txt", name: "old.txt", state: "ready", versionNumber: 1, contentHash: null, reason: null }));
  expect(view.result.current.activeRelativePath).toBeNull();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ workspaceId: "other-workspace", generation: "1" });
  view.rerender({ root: "/other", projectId: 7 });
  await waitFor(() => expect(recordDocumentApi.bindingGet).toHaveBeenCalledWith("/other"));
  expect(view.result.current.activeFileId).toBeNull();
});
