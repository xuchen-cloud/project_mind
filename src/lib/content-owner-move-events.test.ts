import { beforeEach, expect, it, vi } from "vitest";
import { desktopApi } from "../services/desktopApi";
import { publishFileReplacedReceipt, subscribeFileReplaced } from "./content-owner-move-events";

vi.mock("../services/desktopApi", () => ({ desktopApi: { listenEvent: vi.fn() } }));
const event = { binding: { workspaceId: "w", generation: "g" }, operationId: "move",
  object: { workspaceId: "w", kind: "file" as const, scope: { kind: "workspace" as const }, id: "7" },
  versionNumber: 3, contentHash: "hash", noChange: false, oldSessionsClosed: true };
beforeEach(() => vi.clearAllMocks());
it("routes a confirmed local receipt and native notification through the same instance handler", async () => {
  let native!: (payload: typeof event) => void;
  const stop = vi.fn();
  vi.mocked(desktopApi.listenEvent).mockImplementation(async (_topic, listener) => { native = listener; return stop; });
  const receive = vi.fn();
  const dispose = await subscribeFileReplaced(receive);
  publishFileReplacedReceipt(event);
  native(event);
  expect(receive.mock.calls).toEqual([[event], [event]]);
  dispose();
  publishFileReplacedReceipt(event);
  expect(receive).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledOnce();
});
