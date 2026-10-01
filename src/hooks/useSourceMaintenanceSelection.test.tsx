import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSourceMaintenanceSelection } from "./useSourceMaintenanceSelection";
import { agentApi } from "../services/agentApi";
import { recordDocumentApi } from "../services/recordDocumentApi";

vi.mock("../services/agentApi", () => ({ agentApi: { sourceMaintenance: vi.fn() } }));
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
const binding = { workspaceId: "w1", generation: "g1" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VITE_MIND_SOURCE_INDEXING_DEV", "1");
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(agentApi.sourceMaintenance).mockResolvedValue(null);
});
afterEach(() => { vi.unstubAllEnvs(); delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__; });

it("requires the explicit development gate", () => {
  vi.stubEnv("VITE_MIND_SOURCE_INDEXING_DEV", "");
  renderHook(() => useSourceMaintenanceSelection("/workspace/a", 7));
  expect(recordDocumentApi.bindingGet).not.toHaveBeenCalled();
  expect(agentApi.sourceMaintenance).not.toHaveBeenCalled();
});

it("selects only the active route and refreshes the binding on focus", async () => {
  const { rerender, unmount } = renderHook(({ projectId }) => useSourceMaintenanceSelection("/workspace/a", projectId), { initialProps: { projectId: 7 as number | null } });
  await waitFor(() => expect(agentApi.sourceMaintenance).toHaveBeenCalledWith(binding, { kind: "project", projectId: 7 }, "activate"));
  rerender({ projectId: 9 });
  await waitFor(() => expect(agentApi.sourceMaintenance).toHaveBeenCalledWith(binding, { kind: "project", projectId: 9 }, "activate"));
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ ...binding, generation: "g2" });
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(agentApi.sourceMaintenance).toHaveBeenLastCalledWith({ ...binding, generation: "g2" }, { kind: "project", projectId: 9 }, "activate"));
  unmount();
  act(() => window.dispatchEvent(new Event("focus")));
  expect(agentApi.sourceMaintenance).toHaveBeenCalledTimes(3);
});

it("drops a stale selection while its old binding is being resolved", async () => {
  let resolve!: (value: typeof binding) => void;
  vi.mocked(recordDocumentApi.bindingGet).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const { rerender } = renderHook(({ root }) => useSourceMaintenanceSelection(root, null), { initialProps: { root: "/workspace/a" } });
  rerender({ root: "/workspace/b" });
  await waitFor(() => expect(agentApi.sourceMaintenance).toHaveBeenCalledTimes(1));
  await act(async () => resolve({ ...binding, generation: "old" }));
  expect(agentApi.sourceMaintenance).toHaveBeenCalledTimes(1);
  expect(agentApi.sourceMaintenance).toHaveBeenLastCalledWith(binding, { kind: "workspace" }, "activate");
});

it("settles an already dispatched selection before sending the new route", async () => {
  let resolve!: () => void;
  vi.mocked(agentApi.sourceMaintenance).mockImplementationOnce(() => new Promise(done => { resolve = () => done(null); }));
  const { rerender } = renderHook(({ projectId }) => useSourceMaintenanceSelection("/workspace/a", projectId), { initialProps: { projectId: 7 } });
  await waitFor(() => expect(agentApi.sourceMaintenance).toHaveBeenCalledTimes(1));
  rerender({ projectId: 9 });
  await waitFor(() => expect(recordDocumentApi.bindingGet).toHaveBeenCalledTimes(2));
  expect(agentApi.sourceMaintenance).toHaveBeenCalledTimes(1);
  await act(async () => resolve());
  await waitFor(() => expect(agentApi.sourceMaintenance).toHaveBeenLastCalledWith(binding, { kind: "project", projectId: 9 }, "activate"));
});
