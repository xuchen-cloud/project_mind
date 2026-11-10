import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FileVersionLabelEditor, type FileVersionLabelEditorProps } from "./FileVersionLabelEditor";

const version = { id: "v2", versionNumber: 2, displayName: "评审修改", isImportant: true };
function setup(overrides: Partial<FileVersionLabelEditorProps> = {}) {
  const props: FileVersionLabelEditorProps = { version, onSave: vi.fn(async () => {}), ...overrides };
  return { ...render(<FileVersionLabelEditor {...props} />), props };
}
const nameInput = () => screen.getByRole("textbox", { name: "自定义版本名称" });
const saveButton = () => screen.getByRole("button", { name: "保存" });
function rename(value: string) { fireEvent.change(nameInput(), { target: { value } }); }

describe("FileVersionLabelEditor", () => {
  it("displays the immutable version number, custom name and readable important state without auto-saving", () => {
    const { props } = setup();
    expect(screen.getByText("V2（评审修改）")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "重要版本" })).toBeChecked();
    rename("新名称");
    fireEvent.click(screen.getByRole("checkbox", { name: "重要版本" }));
    expect(props.onSave).not.toHaveBeenCalled();
  });
  it.each([["  新名称  ", "新名称"], ["   ", null], ["", null]])("saves an explicit normalized label and important flag: %s", async (input, expected) => {
    const { props } = setup();
    rename(input!);
    fireEvent.click(screen.getByRole("checkbox", { name: "重要版本" }));
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith({ displayName: expected, isImportant: false });
    expect(screen.getByRole("status")).toHaveTextContent("已保存");
  });

  it("accepts 200 Unicode code points and rejects 201 without truncating input", async () => {
    const { props } = setup();
    rename("😀".repeat(201));
    fireEvent.click(saveButton());
    expect(screen.getByRole("alert")).toHaveTextContent("最多 200 个 Unicode 字符");
    expect(nameInput()).toHaveValue("😀".repeat(201));
    expect(props.onSave).not.toHaveBeenCalled();
    rename("😀".repeat(200));
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(props.onSave).toHaveBeenCalledExactlyOnceWith({ displayName: "😀".repeat(200), isImportant: true });
  });

  it.each(["bad\u0001name", "bad\u007fname", "bad\u0085name", "\tname"])("rejects control characters and preserves the original input", input => {
    const { props } = setup();
    rename(input);
    fireEvent.click(saveButton());
    expect(screen.getByRole("alert")).toHaveTextContent("不能包含控制字符");
    expect(nameInput()).toHaveValue(input);
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("retains both fields on failure and retries without auto-saving", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("版本标记冲突，请重试")).mockResolvedValueOnce(undefined);
    setup({ onSave });
    rename("保留输入");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("版本标记冲突，请重试");
    expect(nameInput()).toHaveValue("保留输入");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    fireEvent.click(saveButton());
    expect(await screen.findByRole("status")).toHaveTextContent("已保存");
    expect(onSave.mock.calls).toEqual([
      [{ displayName: "保留输入", isImportant: false }],
      [{ displayName: "保留输入", isImportant: false }],
    ]);
  });

  it("prevents duplicate submissions and editing while saving", async () => {
    let finish!: () => void;
    const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    setup({ onSave });
    fireEvent.click(saveButton());
    expect(nameInput()).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    const pendingButton = screen.getByRole("button", { name: "保存中…" });
    expect(pendingButton).toBeDisabled();
    fireEvent.click(pendingButton);
    expect(onSave).toHaveBeenCalledOnce();
    await act(async () => finish());
    expect(nameInput()).toBeEnabled();
    expect(saveButton()).toBeEnabled();
  });

  it("honors disabled without saving", () => {
    const { props } = setup({ disabled: true });
    expect(nameInput()).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("ignores a previous version's %s while the new version is saving", async result => {
    let resolveOld!: () => void;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: () => void;
    const oldSave = vi.fn(() => new Promise<void>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }));
    const newSave = vi.fn(() => new Promise<void>(resolve => { resolveNew = resolve; }));
    const { props, rerender } = setup({ onSave: oldSave });
    rename("旧版本编辑");
    fireEvent.click(saveButton());
    rerender(<FileVersionLabelEditor {...props} version={{ id: "v3", versionNumber: 3, displayName: null, isImportant: false }} onSave={newSave} />);
    expect(screen.getByText("V3")).toBeVisible();
    expect(nameInput()).toHaveValue("");
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    rename("新版本编辑");
    fireEvent.click(saveButton());
    await act(async () => { if (result === "success") resolveOld(); else rejectOld(new Error("旧版本失败")); });
    expect(nameInput()).toHaveValue("新版本编辑");
    expect(nameInput()).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(oldSave).toHaveBeenCalledExactlyOnceWith({ displayName: "旧版本编辑", isImportant: true });
    expect(newSave).toHaveBeenCalledExactlyOnceWith({ displayName: "新版本编辑", isImportant: false });
    await act(async () => resolveNew());
    expect(screen.getByRole("status")).toHaveTextContent("已保存");
  });

  it("updates the confirmed title only after success and resets it for a new version", async () => {
    const onSave = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("保存失败"));
    const { props, rerender } = setup({ onSave });
    rename("  新确认名称  ");
    expect(screen.getByText("V2（评审修改）")).toBeVisible();
    fireEvent.click(saveButton());
    await screen.findByRole("status");
    expect(screen.getByText("V2（新确认名称）")).toBeVisible();
    rename("未保存名称");
    fireEvent.click(saveButton());
    await screen.findByRole("alert");
    expect(screen.getByText("V2（新确认名称）")).toBeVisible();
    expect(nameInput()).toHaveValue("未保存名称");
    rerender(<FileVersionLabelEditor {...props} version={{ id: "v3", versionNumber: 3, displayName: "另一个版本", isImportant: false }} />);
    expect(screen.getByText("V3（另一个版本）")).toBeVisible();
    expect(nameInput()).toHaveValue("另一个版本");
  });

  it("removes the confirmed title suffix after successfully clearing the name", async () => {
    setup();
    rename("   ");
    fireEvent.click(saveButton());
    await screen.findByRole("status");
    expect(screen.getByText("V2")).toBeVisible();
  });

});
