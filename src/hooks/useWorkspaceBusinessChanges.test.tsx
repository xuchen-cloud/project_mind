import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceBusinessChanges } from "./useWorkspaceBusinessChanges";
import { desktopApi } from "../services/desktopApi";
import { agentApi } from "../services/agentApi";
import { recordDocumentApi } from "../services/recordDocumentApi";
import { queryKeys } from "../lib/queryKeys";

vi.mock("../services/desktopApi", () => ({ desktopApi: { listenEvent: vi.fn() } }));
vi.mock("../services/agentApi", () => ({ agentApi: { businessChangesList: vi.fn() } }));
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
const binding = { workspaceId: "w1", generation: "g1" };
const unlisten = vi.fn();
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
  vi.mocked(desktopApi.listenEvent).mockResolvedValue(unlisten);
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(agentApi.businessChangesList).mockResolvedValue({ entries: [], cursor: 5, hasMore: false, resetRequired: false });
});
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

it("subscribes before reading, catches up on focus, and resets the cursor on generation change", async () => {
  const { wrapper } = setup();
  const { rerender, unmount } = renderHook(({ root }) => useWorkspaceBusinessChanges(root), { wrapper, initialProps: { root: "/one" } });
  await waitFor(() => expect(agentApi.businessChangesList).toHaveBeenCalledWith(binding, 0));
  expect(vi.mocked(desktopApi.listenEvent).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(recordDocumentApi.bindingGet).mock.invocationCallOrder[0]);
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(agentApi.businessChangesList).toHaveBeenCalledWith(binding, 5));
  const next = { ...binding, generation: "g2" };
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(next);
  rerender({ root: "/two" });
  await waitFor(() => expect(agentApi.businessChangesList).toHaveBeenCalledWith(next, 0));
  expect(unlisten).toHaveBeenCalledTimes(1);
  unmount();
  expect(unlisten).toHaveBeenCalledTimes(2);
});

it("retries a failed binding read on focus without registering twice", async () => {
  const { wrapper } = setup();
  vi.mocked(recordDocumentApi.bindingGet).mockRejectedValueOnce(new Error("binding failed"));
  const { result, unmount } = renderHook(() => useWorkspaceBusinessChanges("/one"), { wrapper });
  await waitFor(() => expect(result.current).toBeInstanceOf(Error));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(agentApi.businessChangesList).toHaveBeenCalledWith(binding, 0));
  await waitFor(() => expect(result.current).toBeNull());
  expect(desktopApi.listenEvent).toHaveBeenCalledTimes(1);
  unmount();
});

it("disposes a late subscription and prevents old log replies from changing the cache", async () => {
  const { wrapper, client } = setup();
  let resolveSubscription!: (value: () => void) => void;
  vi.mocked(desktopApi.listenEvent).mockReturnValueOnce(new Promise(resolve => { resolveSubscription = resolve; }));
  const first = renderHook(() => useWorkspaceBusinessChanges("/one"), { wrapper });
  first.unmount();
  await act(async () => { resolveSubscription(unlisten); });
  expect(unlisten).toHaveBeenCalledTimes(1);
  expect(recordDocumentApi.bindingGet).not.toHaveBeenCalled();
  let resolvePage!: (value: Awaited<ReturnType<typeof agentApi.businessChangesList>>) => void;
  vi.mocked(agentApi.businessChangesList).mockReturnValueOnce(new Promise(resolve => { resolvePage = resolve; }));
  client.setQueryData(queryKeys.workspacePage, "current");
  const second = renderHook(() => useWorkspaceBusinessChanges("/one"), { wrapper });
  await waitFor(() => expect(agentApi.businessChangesList).toHaveBeenCalledTimes(1));
  second.unmount();
  await act(async () => { resolvePage({ entries: [], cursor: 6, hasMore: false, resetRequired: true }); });
  expect(client.getQueryState(queryKeys.workspacePage)?.isInvalidated).toBe(false);
});

it("rechecks the binding on focus when the same Workspace is reopened with a new generation", async () => {
  const { wrapper } = setup();
  const { unmount } = renderHook(() => useWorkspaceBusinessChanges("/one"), { wrapper });
  await waitFor(() => expect(agentApi.businessChangesList).toHaveBeenCalledWith(binding, 0));
  const reopened = { ...binding, generation: "reopened" };
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(reopened);
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(agentApi.businessChangesList).toHaveBeenCalledWith(reopened, 0));
  expect(desktopApi.listenEvent).toHaveBeenCalledTimes(1);
  unmount();
});
