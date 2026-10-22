import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { command: mocks.command } }));
import { MemoryBehaviorEditor } from "./MemoryBehaviorEditor";
const binding = { workspaceId: "w1", generation: "g1" };
const original = { path: "/workspace/.project-mind/skills/project-mind-memory/SKILL.md", content: "original", revision: "sha-original" };
beforeEach(() => mocks.command.mockReset().mockResolvedValue(original));
describe("MemoryBehaviorEditor", () => {
  it("saves using captured revision and shows success only after native receipt", async () => {
    const onSaved = vi.fn();
    render(<MemoryBehaviorEditor binding={binding} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("original"));
    expect(screen.getByText(original.path)).toBeInTheDocument();
    let resolve!: (value: typeof original) => void;
    mocks.command.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "new" } });
    fireEvent.click(screen.getByRole("button", { name: "保存行为" }));
    expect(mocks.command).toHaveBeenLastCalledWith("memory_behavior_save", { binding, expectedRevision: original.revision, content: "new" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => resolve({ ...original, content: "new", revision: "sha-new" }));
    expect(await screen.findByRole("status")).toHaveTextContent("行为已保存");
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: "sha-new" }));
  });
  it("preserves draft after concurrent manual edit conflict and reloads explicitly", async () => {
    render(<MemoryBehaviorEditor binding={binding} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("original"));
    mocks.command.mockRejectedValueOnce("REVISION_CONFLICT");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "保存行为" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("REVISION_CONFLICT");
    expect(screen.getByRole("textbox")).toHaveValue("draft");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    mocks.command.mockResolvedValueOnce({ ...original, content: "manual", revision: "sha-manual" });
    fireEvent.click(screen.getByRole("button", { name: "重新读取行为" }));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("manual"));
  });
  it("ignores a previous workspace's late load", async () => {
    let resolve!: (value: typeof original) => void;
    mocks.command.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ ...original, content: "other workspace" });
    const view = render(<MemoryBehaviorEditor binding={binding} />);
    view.rerender(<MemoryBehaviorEditor binding={{ workspaceId: "w2", generation: "g2" }} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("other workspace"));
    await act(async () => resolve(original));
    expect(screen.getByRole("textbox")).toHaveValue("other workspace");
  });
});
