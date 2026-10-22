import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { command: mocks.command } }));
import { MemoryScheduleEditor, type MemorySchedule } from "./MemoryScheduleEditor";
const binding = { workspaceId: "w1", generation: "g1" };
const original: MemorySchedule = { enabled: false, intervalHours: 24, localTime: "03:00", timezone: "UTC", revision: 5, status: null };
beforeEach(() => mocks.command.mockReset().mockResolvedValue(original));
describe("MemoryScheduleEditor", () => {
  it("saves actual enabled/timezone/interval settings with captured CAS only after explicit Save", async () => {
    render(<MemoryScheduleEditor binding={binding} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "时区" })).toHaveValue("UTC"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "48" } });
    fireEvent.change(screen.getByLabelText("当地时间"), { target: { value: "04:30" } });
    fireEvent.change(screen.getByRole("textbox", { name: "时区" }), { target: { value: "Asia/Shanghai" } });
    expect(mocks.command).toHaveBeenCalledTimes(1);
    let resolve!: (value: MemorySchedule) => void;
    mocks.command.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    fireEvent.click(screen.getByRole("button", { name: "保存整理时间" }));
    expect(mocks.command).toHaveBeenLastCalledWith("memory_schedule_save", { binding, scope: { kind: "workspace" }, input: { enabled: true, intervalHours: 48, localTime: "04:30", timezone: "Asia/Shanghai", expectedRevision: 5 } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => resolve({ ...original, enabled: true, intervalHours: 48, localTime: "04:30", timezone: "Asia/Shanghai", revision: 6 }));
    expect(await screen.findByRole("status")).toHaveTextContent("整理时间已保存");
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
  it("keeps unsaved edits on conflict and surfaces last run failure without pretending success", async () => {
    mocks.command.mockResolvedValueOnce({ ...original, status: { phase: "failed", dueAt: new Date().toISOString(), error: "Memory revision conflict", receipt: null } });
    render(<MemoryScheduleEditor binding={binding} />);
    expect(await screen.findByText(/最近整理错误/)).toHaveTextContent("Memory revision conflict");
    fireEvent.change(screen.getByRole("textbox", { name: "时区" }), { target: { value: "Asia/Tokyo" } });
    mocks.command.mockRejectedValueOnce("设置已变化");
    fireEvent.click(screen.getByRole("button", { name: "保存整理时间" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("设置已变化");
    expect(screen.getByRole("textbox", { name: "时区" })).toHaveValue("Asia/Tokyo");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
  it("ignores an old workspace's late response", async () => {
    let resolve!: (value: MemorySchedule) => void;
    mocks.command.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ ...original, timezone: "Europe/Paris" });
    const view = render(<MemoryScheduleEditor binding={binding} />);
    view.rerender(<MemoryScheduleEditor binding={{ workspaceId: "other", generation: "two" }} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "时区" })).toHaveValue("Europe/Paris"));
    await act(async () => resolve(original));
    expect(screen.getByRole("textbox", { name: "时区" })).toHaveValue("Europe/Paris");
  });
});
