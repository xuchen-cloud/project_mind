import { expect, it, vi } from "vitest";
const command = vi.hoisted(() => vi.fn().mockResolvedValue({ facts: [], proposals: [], settings: { requireApproval: false } }));
vi.mock("./desktopApi", () => ({ desktopApi: { command } }));
import { memoryApi } from "./memoryApi";
it("uses the public native command without supplying trusted origin or sources", async () => {
  const request = { operation: "list", scope: { kind: "project", projectId: 4 }, includeInactive: true } as const;
  const binding = { workspaceId: "w1", generation: "g1" };
  await memoryApi.execute(binding, request.scope, request);
  expect(command).toHaveBeenCalledWith("memory_execute", { binding, scope: request.scope, request });
});
