import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { useDocumentImportFlow } from "./useDocumentImportFlow";
import { projectMindApi } from "../services/projectMindApi";
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn(async () => ({ workspaceId: "w", generation: "g" })) } }));
vi.mock("../services/projectMindApi", () => ({ projectMindApi: { projectTagSettingsGet: vi.fn(), documentImport: vi.fn() } }));
it("imports a Workspace File with a null owner and Workspace tags through the shared import flow", async () => {
  vi.mocked(projectMindApi.projectTagSettingsGet).mockResolvedValue({ tags: [], defaultTagId: null } as never);
  vi.mocked(projectMindApi.documentImport).mockResolvedValue({ id: 9, projectId: null, name: "plan.md" } as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result } = renderHook(() => useDocumentImportFlow({ projectId: null, workspaceRoot: "/workspace" }), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  await waitFor(() => expect(projectMindApi.projectTagSettingsGet).toHaveBeenCalledWith({ projectId: null }));
  await act(async () => { await result.current.requestImportPaths(["/incoming/plan.md"]); });
  expect(projectMindApi.documentImport).toHaveBeenCalledWith({ projectId: null, sourcePath: "/incoming/plan.md", isStarred: false }, { workspaceId: "w", generation: "g" });
});

it("does not import after its Workspace owner changes while the binding request is pending", async () => {
  const { recordDocumentApi } = await import("../services/recordDocumentApi");
  vi.mocked(projectMindApi.documentImport).mockClear();
  let resolve!: (binding: { workspaceId: string; generation: string }) => void;
  vi.mocked(recordDocumentApi.bindingGet).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { result, rerender } = renderHook(({ root }) => useDocumentImportFlow({ projectId: null, workspaceRoot: root }), { initialProps: { root: "/workspace/one" }, wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
  let request!: Promise<unknown>;
  act(() => { request = result.current.requestImportPaths(["/incoming/old.md"]); });
  rerender({ root: "/workspace/two" });
  await act(async () => { resolve({ workspaceId: "one", generation: "old" }); await request; });
  expect(projectMindApi.documentImport).not.toHaveBeenCalled();
});
