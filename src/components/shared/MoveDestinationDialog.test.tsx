import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MoveDestinationDialog, type MoveDestinationDialogProps } from "./MoveDestinationDialog";

function setup(overrides: Partial<MoveDestinationDialogProps> = {}) {
  const props: MoveDestinationDialogProps = {
    title: "移动文件", workspaceName: "研究空间",
    projects: [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }, { id: 3, name: "Gamma", isArchived: true }],
    currentProjectId: 1, onMove: vi.fn(async () => {}), onClose: vi.fn(), ...overrides,
  };
  return { ...render(<MoveDestinationDialog {...props} />), props };
}

function search(query: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索移动目标" }), { target: { value: query } });
}
const submit = () => screen.getByRole("button", { name: "移动" });

describe("MoveDestinationDialog", () => {
  it("labels ownership and disables current and archived destinations", async () => {
    const { props } = setup();
    expect(screen.getByRole("radio", { name: /Alpha.*当前位置/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /工作区根级 · 研究空间/ })).toBeEnabled();
    expect(submit()).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Gamma.*研究空间.*已归档/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Beta.*研究空间/ }));
    fireEvent.click(submit());
    await screen.findByRole("dialog");
    expect(props.onMove).toHaveBeenCalledExactlyOnceWith(2);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("searches names and workspace root with trimmed case-insensitive text and shows no results", () => {
    setup();
    search("  bETA ");
    expect(screen.getByRole("radio", { name: /Beta/ })).toBeVisible();
    expect(screen.queryByRole("radio", { name: /Alpha/ })).not.toBeInTheDocument();
    search("Gamma");
    expect(screen.getByRole("radio", { name: /Gamma.*已归档/ })).toBeDisabled();
    search("工作区根级");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    search("研究空间");
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    search("missing");
    expect(screen.getByRole("status")).toHaveTextContent("没有匹配的移动目标");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    search("   ");
    expect(screen.getAllByRole("radio")).toHaveLength(4);
  });

  it("disables the current root and supports keyboard selection and submission", async () => {
    const user = userEvent.setup();
    const { props } = setup({ currentProjectId: null });
    expect(screen.getByRole("radio", { name: /工作区根级.*当前位置/ })).toBeDisabled();
    expect(screen.getByRole("searchbox")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("radio", { name: /Alpha/ })).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByRole("radio", { name: /Alpha/ })).toBeChecked();
    await user.click(submit());
    expect(props.onMove).toHaveBeenCalledExactlyOnceWith(1);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("retains search and selection after failure and retries the same destination", async () => {
    const onMove = vi.fn().mockRejectedValueOnce(new Error("目标暂不可写")).mockResolvedValueOnce(undefined);
    const { props } = setup({ onMove });
    search("根级");
    fireEvent.click(screen.getByRole("radio", { name: /工作区根级/ }));
    fireEvent.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("目标暂不可写");
    expect(screen.getByRole("searchbox")).toHaveValue("根级");
    expect(screen.getByRole("radio")).toBeChecked();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(submit());
    await act(async () => {});
    expect(onMove.mock.calls).toEqual([[null], [null]]);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("blocks duplicate submission, changing destination, Escape, backdrop and close while pending", async () => {
    let finish!: () => void;
    const onMove = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const { props } = setup({ onMove });
    fireEvent.click(screen.getByRole("radio", { name: /Beta/ }));
    fireEvent.click(submit());
    fireEvent.click(screen.getByRole("button", { name: "移动中…" }));
    expect(screen.getByRole("radio", { name: /工作区根级/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onMove).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("shows loading and supplied errors, then accepts updated destinations without losing selection", () => {
    const { props, rerender } = setup({ loading: true });
    expect(screen.getByRole("status")).toHaveTextContent("正在加载移动目标");
    expect(screen.getByRole("radio", { name: /Beta/ })).toBeDisabled();
    rerender(<MoveDestinationDialog {...props} loading={false} error="加载项目失败" />);
    expect(screen.getByRole("alert")).toHaveTextContent("加载项目失败");
    fireEvent.click(screen.getByRole("radio", { name: /Beta/ }));
    rerender(<MoveDestinationDialog {...props} loading={false} error={undefined} />);
    expect(screen.getByRole("radio", { name: /Beta/ })).toBeChecked();
    rerender(<MoveDestinationDialog {...props} loading={false} projects={[]} />);
    expect(submit()).toBeDisabled();
  });

  it("prevents submitting a selected destination that becomes archived", () => {
    const { props, rerender } = setup();
    fireEvent.click(screen.getByRole("radio", { name: /Beta/ }));
    expect(submit()).toBeEnabled();
    rerender(<MoveDestinationDialog {...props} projects={props.projects.map(project => project.id === 2 ? { ...project, isArchived: true } : project)} />);
    expect(screen.getByRole("radio", { name: /Beta.*已归档/ })).toBeDisabled();
    expect(submit()).toBeDisabled();
    fireEvent.click(submit());
    expect(props.onMove).not.toHaveBeenCalled();
  });

  it("keeps the search and actions outside the shared bounded list and allows idle dismissal", () => {
    const { props } = setup();
    const list = screen.getByRole("region", { name: "移动目标列表" });
    expect(list.parentElement).toHaveClass("home-side__list-frame");
    expect(within(list).queryByRole("searchbox")).not.toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "移动" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
  it.each(["success", "failure"])("ignores an unmounted dialog's %s after a same-name workspace opens a new dialog", async result => {
    let resolveOld!: () => void;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: () => void;
    const onMove = vi.fn(() => new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
    const nextMove = vi.fn(() => new Promise<void>(resolve => { resolveNew = resolve; }));
    const { props, rerender } = setup({ onMove });
    fireEvent.click(screen.getByRole("radio", { name: /Beta/ }));
    fireEvent.click(submit());
    // Distinct bindings may share a workspace name and numeric project IDs.
    rerender(<MoveDestinationDialog key="binding-b:file-2" {...props} onMove={nextMove} />);
    expect(screen.getByRole("searchbox")).toHaveValue("");
    expect(submit()).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /工作区根级/ }));
    fireEvent.click(submit());
    await act(async () => { if (result === "success") resolveOld(); else rejectOld(new Error("旧目标失败")); });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /工作区根级/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "移动中…" })).toBeDisabled();
    await act(async () => resolveNew());
    expect(nextMove).toHaveBeenCalledExactlyOnceWith(null);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it.each([new Error(), "", "   ", new Error("   ")])("shows a default error for an empty rejection and retries the retained selection: %s", async cause => {
    const onMove = vi.fn().mockRejectedValueOnce(cause).mockResolvedValueOnce(undefined);
    const { props } = setup({ onMove });
    search("Beta");
    fireEvent.click(screen.getByRole("radio", { name: /Beta/ }));
    fireEvent.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("移动失败，请重试。");
    expect(screen.getByRole("radio", { name: /Beta/ })).toBeChecked();
    expect(screen.getByRole("searchbox")).toHaveValue("Beta");
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(submit());
    await act(async () => {});
    expect(onMove.mock.calls).toEqual([[2], [2]]);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

});
