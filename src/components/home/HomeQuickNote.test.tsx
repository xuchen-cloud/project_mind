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
  fireEvent.click(screen.getByRole("button", { name: "保存为记录" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("草稿已保留");
  expect(clear).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "保存为记录" }));
  await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
  expect(commit).toHaveBeenLastCalledWith(draft, { kind: "new" }, { requestId: expect.any(String) });
  expect(commit.mock.calls[0][2]).toEqual(commit.mock.calls[1][2]);
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
  fireEvent.click(screen.getByRole("button", { name: "保存为记录" }));
  await waitFor(() => expect(clear).toHaveBeenCalledOnce());
  expect(await screen.findByText("记录已保存，请刷新列表。")).toBeInTheDocument();
  expect(screen.queryByText("发布失败，草稿已保留。")).not.toBeInTheDocument();
});

it("expands an empty draft on focus and collapses it on page scroll without losing the editor", () => {
  const draft = { html: "<p></p>", markdown: "", text: "" };
  const { container } = render(<div className="project-overview-focus__scroll"><HomeQuickNote identity="empty-scroll" initialValue={draft} records={[]} persist={async () => draft} commit={vi.fn()} onClear={vi.fn()} renderEditor={() => <div contentEditable suppressContentEditableWarning role="textbox" aria-label="空草稿" />} /></div>);
  const editor = screen.getByRole("textbox", { name: "空草稿" });
  const panel = editor.closest(".home-quick-note__panel");
  expect(panel).toHaveClass("is-empty-compact");
  fireEvent.focus(editor);
  expect(panel).toHaveClass("is-empty-expanded");
  fireEvent.scroll(container.firstElementChild!);
  expect(panel).toHaveClass("is-empty-expanded");
  fireEvent.wheel(editor, { deltaY: 20 });
  fireEvent.scroll(container.firstElementChild!, { target: { scrollTop: 20 } });
  expect(panel).toHaveStyle({ "--empty-editor-height": "56px" });
  expect(panel).toHaveClass("is-empty-expanded");
  fireEvent.wheel(editor, { deltaY: 20 });
  fireEvent.scroll(container.firstElementChild!, { target: { scrollTop: 40 } });
  expect(panel).toHaveClass("is-empty-compact");
  expect(screen.getByRole("textbox", { name: "空草稿" })).toBe(editor);
  fireEvent.click(editor);
  expect(panel).toHaveClass("is-empty-expanded");
});

it("moves and scales the page heading continuously in both scroll directions", () => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  const draft = { html: "<p></p>", markdown: "", text: "" };
  const { container } = render(<div className="project-overview-focus__scroll">
    <div className="home-cover"><div className="home-cover__identity">封面标题</div></div>
    <HomeQuickNote identity="heading-test" pageTitle="阅读计划" pageIcon={<span>Logo</span>}
      initialValue={draft} records={[]} persist={async () => draft} commit={vi.fn()} onClear={vi.fn()}
      renderEditor={() => <textarea aria-label="草稿" />} />
  </div>);
  const cover = container.querySelector(".home-cover__identity")!;
  const scroller = container.firstElementChild!;
  const rect = vi.spyOn(cover, "getBoundingClientRect");
  rect.mockReturnValue({ top: 120, left: 0, bottom: 152 } as DOMRect);
  fireEvent.scroll(scroller);
  expect(screen.queryByRole("heading", { name: "阅读计划" })).not.toBeInTheDocument();
  rect.mockReturnValue({ top: 48, left: 0, bottom: 80 } as DOMRect);
  fireEvent.scroll(scroller);
  expect(screen.queryByRole("heading", { name: "阅读计划" })).not.toBeInTheDocument();
  rect.mockReturnValue({ top: 24, left: 0, bottom: 56 } as DOMRect);
  fireEvent.scroll(scroller);
  const heading = screen.getByRole("heading", { name: "阅读计划" }).parentElement!;
  const halfway = heading.style.transform;
  const coverLayer = container.querySelector<HTMLElement>(".home-cover")!;
  expect(coverLayer.style.getPropertyValue("--cover-scenery-opacity")).toBe("0.5");
  rect.mockReturnValue({ top: 8, left: 0, bottom: 40 } as DOMRect);
  fireEvent.scroll(scroller);
  expect(screen.getByRole("heading", { name: "阅读计划", level: 1 })).toBeInTheDocument();
  expect(coverLayer.style.getPropertyValue("--cover-scenery-opacity")).toBe("0");
  rect.mockReturnValue({ top: 120, left: 0, bottom: 152 } as DOMRect);
  fireEvent.scroll(scroller);
  expect(screen.queryByRole("heading", { name: "阅读计划" })).not.toBeInTheDocument();
  expect(heading.style.transform).not.toBe(halfway);
  expect(coverLayer.style.getPropertyValue("--cover-scenery-opacity")).toBe("1");
  rect.mockRestore();
  vi.unstubAllGlobals();
});


it.each([false, true])("fades editor edges proportionally to scroll distance (expanded: %s)", (expanded) => {
  const draft = { html: "<p>正文</p>", markdown: "正文", text: "正文" };
  render(<HomeQuickNote identity="mask-test" initialValue={draft} records={[]} persist={async () => draft} commit={vi.fn()} onClear={vi.fn()}
    renderEditor={() => <div className="rich-editor__frame" data-testid="mask-frame"><div className="rich-editor__surface">正文</div></div>} />);
  const frame = screen.getByTestId("mask-frame");
  Object.defineProperty(frame, "scrollHeight", { configurable: true, value: 1000 });
  Object.defineProperty(frame, "clientHeight", { configurable: true, value: 300 });
  if (expanded) fireEvent.click(screen.getByRole("button", { name: "展开 QuickNote" }));
  fireEvent.scroll(frame);
  expect(frame.style.getPropertyValue("--quick-note-fade-top")).toBe("0");
  expect(frame.style.getPropertyValue("--quick-note-fade-bottom")).toBe("1");
  frame.scrollTop = 32;
  fireEvent.scroll(frame);
  expect(frame.style.getPropertyValue("--quick-note-fade-top")).toBe("0.5");
  frame.scrollTop = 684;
  fireEvent.scroll(frame);
  expect(frame.style.getPropertyValue("--quick-note-fade-bottom")).toBe("0.25");
  frame.scrollTop = 700;
  fireEvent.scroll(frame);
  expect(frame.style.getPropertyValue("--quick-note-fade-bottom")).toBe("0");
  Object.defineProperty(frame, "scrollHeight", { value: 300 });
  fireEvent.scroll(frame);
  expect(frame.style.getPropertyValue("--quick-note-fade-top")).toBe("0");
  expect(frame.style.getPropertyValue("--quick-note-fade-bottom")).toBe("0");
});


it("tracks live empty content before autosave and restores scroll collapse", () => {
  const draft = { html: "<p>draft</p>", markdown: "draft", text: "draft" };
  const { container } = render(<div className="project-overview-focus__scroll"><HomeQuickNote
    identity="live-empty" initialValue={draft} records={[]} persist={async () => draft} commit={vi.fn()} onClear={vi.fn()}
    renderEditor={({ onChange }) => <div contentEditable suppressContentEditableWarning role="textbox" aria-label="实时草稿"
      onInput={(event) => onChange({ html: event.currentTarget.innerHTML, markdown: event.currentTarget.textContent ?? "", text: event.currentTarget.textContent ?? "" })} />}
  /></div>);
  const editor = screen.getByRole("textbox", { name: "实时草稿" });
  const panel = container.querySelector(".home-quick-note__panel");
  fireEvent.focus(editor);
  fireEvent.input(editor, { target: { textContent: "" } });
  expect(panel).toHaveClass("is-empty-expanded");
  expect(screen.getByRole("button", { name: "保存为记录" })).toBeDisabled();
  fireEvent.wheel(editor, { deltaY: 40 });
  expect(panel).toHaveClass("is-empty-compact");
  fireEvent.click(editor);
  expect(panel).toHaveClass("is-empty-expanded");
  fireEvent.input(editor, { target: { textContent: "new draft" } });
  expect(panel).not.toHaveClass("is-empty-expanded");
  expect(screen.getByRole("button", { name: "保存为记录" })).toBeEnabled();
});
