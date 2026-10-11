import { beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("./desktopApi", () => ({ desktopApi: native }));
beforeEach(() => { vi.resetModules(); native.command.mockReset().mockResolvedValue(undefined); });

describe("DSH native command serialization", () => {
  it("shares concurrent readiness, retries errors and rechecks after configuration changes", async () => {
    const { dshAssistantApi } = await import("./dshAssistantApi");
    native.command.mockRejectedValueOnce(new Error("missing GENERAL model"));
    const first = dshAssistantApi.start("workspace:model1", 1);
    expect(dshAssistantApi.start("workspace:model1", 1)).toBe(first);
    await expect(first).rejects.toThrow("missing GENERAL model");
    await dshAssistantApi.start("workspace:model1", 1);
    await dshAssistantApi.start("workspace:model2", 1);
    expect(native.command.mock.calls).toEqual(Array(3).fill(["dsh_assistant_start", { projectId: 1 }]));
  });

  it("serializes project 1 → 2 → 1 rather than reusing the superseded first startup", async () => {
    const { dshAssistantApi } = await import("./dshAssistantApi");
    let release!: () => void;
    native.command.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = dshAssistantApi.start("project1", 1);
    const second = dshAssistantApi.start("project2", 2);
    const back = dshAssistantApi.start("project1", 1);
    expect(back).not.toBe(first);
    await Promise.resolve(); release(); await Promise.all([first, second, back]);
    expect(native.command.mock.calls).toEqual([
      ["dsh_assistant_start", { projectId: 1 }], ["dsh_assistant_start", { projectId: 2 }], ["dsh_assistant_start", { projectId: 1 }],
    ]);
  });

  it("serializes session selection before a following project start and preserves command contracts", async () => {
    const { dshAssistantApi } = await import("./dshAssistantApi");
    native.command.mockResolvedValueOnce([{ id: "chat", title: "会话" }]);
    await expect(dshAssistantApi.sessions(1)).resolves.toEqual([{ id: "chat", title: "会话" }]);
    let release!: () => void;
    native.command.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const select = dshAssistantApi.selectSession("chat", 1);
    const start = dshAssistantApi.start("project2", 2);
    await Promise.resolve(); expect(native.command).toHaveBeenCalledTimes(2);
    release(); await Promise.all([select, start]); await dshAssistantApi.selectSession(null, 2);
    expect(native.command.mock.calls).toEqual([
      ["dsh_assistant_sessions", { projectId: 1 }], ["dsh_assistant_select_session", { projectId: 1, sessionId: "chat" }],
      ["dsh_assistant_start", { projectId: 2 }], ["dsh_assistant_select_session", { projectId: 2, sessionId: null }],
    ]);
  });

  it("returns the real selected session id and forwards owned deletion errors", async () => {
    const { dshAssistantApi } = await import("./dshAssistantApi");
    native.command.mockResolvedValueOnce("created-id");
    await expect(dshAssistantApi.selectSession(null, 7)).resolves.toBe("created-id");
    native.command.mockRejectedValueOnce(new Error("session belongs to a different project"));
    await expect(dshAssistantApi.deleteSession("foreign", 7)).rejects.toThrow("different project");
    expect(native.command.mock.calls).toEqual([
      ["dsh_assistant_select_session", { projectId: 7, sessionId: null }],
      ["dsh_assistant_delete_session", { projectId: 7, sessionId: "foreign" }],
    ]);
  });
});
