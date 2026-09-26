import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { HomeQuickNote } from "./HomeQuickNote";
import type { RichEditorController } from "../rich-editor";

it("autosaves only the draft and preserves it when publishing fails", async () => {
  const draft = { html: "<p>项目计划</p>", markdown: "项目计划", text: "项目计划" };
  const persist = vi.fn(async () => draft);
  const commit = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ id: 1 });
  const clear = vi.fn();
  const replace = vi.fn();
  render(<HomeQuickNote identity="project:1" initialValue={draft} records={[]} persist={persist} commit={commit} onClear={clear}
    renderEditor={({ controllerRef, onSave }) => {
      controllerRef.current = { getCommittedValue: () => draft, replaceCommittedContent: replace, setEditable: vi.fn(), save: () => onSave(draft) } as unknown as RichEditorController;
      return <button onClick={() => void onSave(draft)}>模拟自动保存</button>;
    }} />);
  fireEvent.click(screen.getByText("模拟自动保存"));
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
  expect(commit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("存为记录"));
  expect(await screen.findByRole("alert")).toHaveTextContent("草稿已保留");
  expect(clear).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("存为记录"));
  await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
  expect(commit).toHaveBeenLastCalledWith(draft, { kind: "new" });
  expect(replace).toHaveBeenCalledWith("<p></p>");
});

it("keeps the same editor mounted when expanded and restores focus on Escape", async () => {
  const draft = { html: "<p></p>", markdown: "", text: "" };
  render(<HomeQuickNote identity="workspace" initialValue={draft} records={[]} persist={async () => draft} commit={vi.fn()} onClear={vi.fn()}
    renderEditor={() => <textarea aria-label="草稿" defaultValue="未保存输入" />} />);
  const editor = screen.getByLabelText("草稿");
  const expand = screen.getByRole("button", { name: "展开 QuickNote" });
  fireEvent.click(expand);
  expect(screen.getByRole("dialog", { name: "展开 QuickNote" })).toBeInTheDocument();
  expect(screen.getByLabelText("草稿")).toBe(editor);
  fireEvent.keyDown(editor, { key: "Escape" });
  await waitFor(() => expect(expand).toHaveFocus());
  expect(screen.getByLabelText("草稿")).toHaveValue("未保存输入");
});

it("reports a refresh failure separately after the Record was successfully published", async () => {
  const draft = { html: "<p>已发布</p>", markdown: "已发布", text: "已发布" };
  const clear = vi.fn();
  render(<HomeQuickNote identity="workspace" initialValue={draft} records={[]} persist={async () => draft} commit={async () => ({ id: 1 })} onClear={clear} onCommitted={async () => { throw new Error("refresh failed"); }}
    renderEditor={({ controllerRef }) => {
      controllerRef.current = { getCommittedValue: () => draft, replaceCommittedContent: vi.fn(), setEditable: vi.fn() } as unknown as RichEditorController;
      return <p>已发布</p>;
    }} />);
  fireEvent.click(screen.getByText("存为记录"));
  await waitFor(() => expect(clear).toHaveBeenCalledOnce());
  expect(await screen.findByText("记录已保存，请刷新列表。")).toBeInTheDocument();
  expect(screen.queryByText("发布失败，草稿已保留。")).not.toBeInTheDocument();
});
