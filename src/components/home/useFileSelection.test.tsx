import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { fileSelectionData, useFileSelection, type FileSelectionItem } from "./useFileSelection";

const rows: FileSelectionItem[] = [
  { key: "directory:folder", relativePath: "folder", kind: "directory" },
  { key: "file:1:folder/a.txt", relativePath: "folder/a.txt", kind: "file", fileId: 1 },
  { key: "file:2:folder/b.txt", relativePath: "folder/b.txt", kind: "file", fileId: 2 },
  { key: "directory:folder-other", relativePath: "folder-other", kind: "directory" },
  { key: "file:3:z.txt", relativePath: "z.txt", kind: "file", fileId: 3 },
];

function fixture() {
  let selection!: ReturnType<typeof useFileSelection>;
  const open = vi.fn();
  const context = vi.fn();
  function Harness({ scope = "owner-a", items = rows, hidden = [] }: { scope?: string; items?: FileSelectionItem[]; hidden?: string[] }) {
    const root = useRef<HTMLDivElement>(null);
    selection = useFileSelection(scope, root);
    return <><div ref={root}>{items.map(item => <div key={item.key} hidden={hidden.includes(item.relativePath)}>
      <div role="button" tabIndex={0} aria-label={item.relativePath} {...fileSelectionData(item)} aria-pressed={selection.selected.has(item.key)}
        onClick={event => { if (!selection.onClick(item, event)) open(item); }}
        onMouseDown={event => selection.onMouseDown(item, event)}
        onContextMenu={event => context(selection.onContextMenu(item, event))}>
        {item.relativePath}<input aria-label={`rename ${item.relativePath}`} />
      </div>
    </div>)}</div><input aria-label="editor" /></>;
  }
  const view = render(<Harness />);
  const row = (index: number) => screen.getByRole("button", { name: rows[index].relativePath });
  const selected = () => [...selection.selected];
  return { ...view, Harness, row, open, context, selected, controls: () => selection };
}

describe("useFileSelection", () => {
  it("sets plain selection and anchor, then expands and shrinks Shift ranges without moving the anchor", async () => {
    const view = fixture();
    const user = userEvent.setup();
    await user.click(view.row(1));
    expect(view.open).toHaveBeenCalledWith(rows[1]);
    await user.keyboard("{Shift>}");
    await user.click(view.row(4));
    expect(view.selected()).toEqual(rows.slice(1).map(item => item.key));
    await user.click(view.row(2));
    expect(view.selected()).toEqual(rows.slice(1, 3).map(item => item.key));
    await user.click(view.row(0));
    expect(view.selected()).toEqual(rows.slice(0, 2).map(item => item.key));
    await user.keyboard("{/Shift}");
    expect(view.open).toHaveBeenCalledTimes(1);
  });

  it.each(["Control", "Meta"])("toggles using %s and shrinks union ranges against a fixed base", async modifier => {
    const view = fixture();
    const user = userEvent.setup();
    await user.click(view.row(0));
    await user.keyboard(`{${modifier}>}`);
    await user.click(view.row(4));
    await user.click(view.row(4));
    expect(view.selected()).toEqual([rows[0].key]);
    await user.click(view.row(2));
    await user.keyboard("{Shift>}");
    await user.click(view.row(4));
    expect(new Set(view.selected())).toEqual(new Set([rows[0], ...rows.slice(2)].map(item => item.key)));
    await user.click(view.row(3));
    expect(new Set(view.selected())).toEqual(new Set([rows[0], rows[2], rows[3]].map(item => item.key)));
    await user.keyboard(`{/Shift}{/${modifier}}`);
    expect(view.open).toHaveBeenCalledTimes(1);
  });

  it("preserves a right-clicked group and replaces it when right-clicking an unselected item", () => {
    const view = fixture();
    fireEvent.click(view.row(0));
    fireEvent.click(view.row(2), { ctrlKey: true });
    fireEvent.contextMenu(view.row(0));
    expect(view.context).toHaveBeenLastCalledWith([rows[0], rows[2]]);
    fireEvent.contextMenu(view.row(4));
    expect(view.context).toHaveBeenLastCalledWith([rows[4]]);
    expect(view.selected()).toEqual([rows[4].key]);
  });

  it("uses current rendered order and excludes hidden rows when selecting ranges", () => {
    const view = fixture();
    const reordered = [rows[4], rows[2], rows[0], rows[3], rows[1]];
    view.rerender(<view.Harness items={reordered} hidden={[rows[0].relativePath]} />);
    fireEvent.click(view.row(4));
    fireEvent.click(view.row(1), { shiftKey: true });
    expect(view.selected()).toEqual([rows[4], rows[2], rows[3], rows[1]].map(item => item.key));
  });

  it("prunes hidden, filtered, deleted rows and anchor from actual DOM changes", async () => {
    const view = fixture();
    fireEvent.click(view.row(1));
    fireEvent.click(view.row(4), { shiftKey: true });
    view.rerender(<view.Harness hidden={[rows[1].relativePath]} items={rows.filter(item => item !== rows[2])} />);
    await waitFor(() => expect(view.selected()).toEqual([rows[3].key, rows[4].key]));
    fireEvent.click(view.row(0), { shiftKey: true });
    expect(view.selected()).toEqual([rows[0].key]);
    act(() => view.row(0).setAttribute("style", "display:none"));
    await waitFor(() => expect(view.selected()).toEqual([]));
  });

  it("clears on owner change and unmount, and removes successful folders with their selected descendants", () => {
    const view = fixture();
    fireEvent.click(view.row(0));
    fireEvent.click(view.row(4), { shiftKey: true });
    act(() => view.controls().remove(["folder"]));
    expect(view.selected()).toEqual([rows[3].key, rows[4].key]);
    view.rerender(<view.Harness scope="owner-b" />);
    expect(view.selected()).toEqual([]);
    fireEvent.click(view.row(4), { shiftKey: true });
    expect(view.selected()).toEqual([rows[4].key]);
    act(() => view.controls().clear());
    expect(view.selected()).toEqual([]);
    view.unmount();
    render(<view.Harness />);
    expect(view.selected()).toEqual([]);
  });

  it("leaves interactive descendants and external editor keyboard shortcuts alone", async () => {
    const view = fixture();
    const user = userEvent.setup();
    await user.click(view.row(0));
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("textbox", { name: "rename folder/a.txt" }));
    fireEvent.contextMenu(screen.getByRole("textbox", { name: "rename folder/a.txt" }), { button: 2, ctrlKey: true });
    await user.keyboard("{/Control}");
    expect(view.selected()).toEqual([rows[0].key]);
    await user.click(screen.getByRole("textbox", { name: "editor" }));
    await user.type(screen.getByRole("textbox", { name: "editor" }), "draft");
    await user.keyboard("{Control>}a{/Control}{Backspace}");
    expect(screen.getByRole("textbox", { name: "editor" })).toHaveValue("");
    expect(view.selected()).toEqual([rows[0].key]);
  });

  it.each([false, true])("consumes macOS Ctrl-primary context menus exactly once (trailing click=%s)", trailingClick => {
    const view = fixture();
    fireEvent.click(view.row(0));
    const row = view.row(2);
    fireEvent.mouseDown(row, { button: 0, ctrlKey: true });
    fireEvent.contextMenu(row, { button: 2, ctrlKey: true });
    expect(view.context).toHaveBeenLastCalledWith(undefined);
    if (trailingClick) fireEvent.click(row, { ctrlKey: true });
    expect(view.selected()).toEqual([rows[0].key, rows[2].key]);
    expect(view.open).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(row, { button: 0, ctrlKey: true });
    fireEvent.contextMenu(row, { button: 0, ctrlKey: true });
    if (trailingClick) fireEvent.click(row, { ctrlKey: true });
    expect(view.selected()).toEqual([rows[0].key]);
    fireEvent.mouseDown(view.row(0), { button: 2, ctrlKey: true });
    fireEvent.contextMenu(view.row(0), { button: 2, ctrlKey: true });
    expect(view.context).toHaveBeenLastCalledWith([rows[0]]);
  });
});
