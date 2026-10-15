import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useRecordClipboard } from "./useRecordClipboard";
import { recordDocumentApi } from "../services/recordDocumentApi";
vi.mock("../services/recordDocumentApi", () => ({ recordDocumentApi: { cutRegister: vi.fn(), cutClaim: vi.fn() } }));
beforeEach(() => vi.resetAllMocks());
it("keeps the transport stable and resolves the current bound destination for each clipboard operation", async () => {
  const binding = { workspaceId: "workspace", generation: "opened" };
  const target = { scope: { kind: "workspace" as const }, recordId: 7 };
  const view = renderHook((props) => useRecordClipboard(props.binding, props.target), { initialProps: { binding, target } });
  const transport = view.result.current;
  await transport.registerCut("token");
  expect(recordDocumentApi.cutRegister).toHaveBeenCalledWith(binding, target, "token");
  const reopened = { ...binding, generation: "reopened" };
  const destination = { ...target, recordId: 8 };
  view.rerender({ binding: reopened, target: destination });
  expect(view.result.current).toBe(transport);
  vi.mocked(recordDocumentApi.cutClaim).mockResolvedValue(false);
  expect(await transport.claimCut("token")).toBe(false);
  expect(recordDocumentApi.cutClaim).toHaveBeenCalledWith(reopened, destination, "token");
});
it("an unavailable editor binding cannot register or claim move identity", async () => {
  const { result } = renderHook(() => useRecordClipboard(null, null));
  await result.current.registerCut("token");
  expect(await result.current.claimCut("token")).toBe(false);
  expect(recordDocumentApi.cutRegister).not.toHaveBeenCalled();
  expect(recordDocumentApi.cutClaim).not.toHaveBeenCalled();
});
