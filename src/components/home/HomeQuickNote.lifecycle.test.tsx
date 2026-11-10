import { flushSync } from "react-dom";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, it, vi } from "vitest";
import { HomeQuickNote } from "./HomeQuickNote";
import { RichEditor, type RichEditorController } from "../rich-editor/RichEditor";
import { assertQuickNotesSaved, flushQuickNotes, holdQuickNotes } from "../../lib/quick-note-transfer";

// Adapted from the retained F3/F4 probes; only persistence is a controlled boundary.
it("rejects a hidden failed QuickNote flush and retries its committed draft after recovery", async () => {
  const user = userEvent.setup();
  const controllerRef = { current: null as RichEditorController | null };
  const initial = { html: "<p>original</p>", markdown: "original", text: "original" };
  let failing = true;
  const persist = vi.fn(async (value: typeof initial) => {
    if (failing) throw new Error("storage failure");
    return value;
  });
  const ui = (visible: boolean) => <HomeQuickNote identity="review-hidden" editorControllerRef={controllerRef}
    initialValue={initial} records={[]} persist={persist} commit={async () => ({})} onClear={() => {}}
    renderEditor={options => <RichEditor variant="bare" html={initial.html} controllerRef={options.controllerRef}
      readOnly={!visible || options.readOnly} onSave={options.onSave} onChange={options.onChange}
      onPersistStateChange={options.onPersistStateChange}
      autosave={{ delay: 120000, onBlur: true, onWindowBlur: true, onVisibilityChange: true }} />} />;
  const view = render(ui(true));
  await waitFor(() => expect(controllerRef.current).not.toBeNull());
  act(() => controllerRef.current!.focus("end"));
  await user.keyboard(" UNSAVED");
  await act(async () => { await expect(controllerRef.current!.save({ force: true })).rejects.toThrow("storage failure"); });
  const before = persist.mock.calls.length;
  view.rerender(ui(false));
  await act(async () => { await expect(flushQuickNotes()).rejects.toThrow("storage failure"); });
  expect(persist.mock.calls.length).toBeGreaterThan(before);
  expect(controllerRef.current!.getCommittedValue().markdown).toContain("UNSAVED");
  expect(controllerRef.current!.hasUnsavedCommittedContent()).toBe(true);
  failing = false;
  await act(async () => { await flushQuickNotes(); });
  expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: expect.stringContaining("UNSAVED") }));
  expect(controllerRef.current!.hasUnsavedCommittedContent()).toBe(false);
  view.unmount();
});

it("captures a QuickNote immediately before close instead of relying on delayed blur", async () => {
  const user = userEvent.setup();
  const controllerRef = { current: null as RichEditorController | null };
  const initial = { html: "<p>original</p>", markdown: "original", text: "original" };
  const persist = vi.fn(async (value: typeof initial) => value);
  const view = render(<HomeQuickNote identity="review-unmount" editorControllerRef={controllerRef}
    initialValue={initial} records={[]} persist={persist} commit={async () => ({})} onClear={() => {}}
    renderEditor={options => <RichEditor variant="bare" html={initial.html} controllerRef={options.controllerRef}
      onSave={options.onSave} onChange={options.onChange} onPersistStateChange={options.onPersistStateChange}
      autosave={{ delay: 120000, onBlur: true }} />} />);
  await waitFor(() => expect(controllerRef.current).not.toBeNull());
  act(() => controllerRef.current!.focus("end"));
  await user.keyboard(" UNSAVED");
  fireEvent.blur(view.container.querySelector(".ProseMirror")!);
  await act(async () => { await flushQuickNotes(); });
  expect(persist).toHaveBeenCalledWith(expect.objectContaining({ markdown: expect.stringContaining("UNSAVED") }));
  view.unmount();
});

it("rejects a new QuickNote edit at the synchronous final close check", async () => {
  const user = userEvent.setup();
  const scope = { workspaceRoot: "/late-close", projectId: 1 };
  const controllerRef = { current: null as RichEditorController | null };
  const initial = { html: "<p>original</p>", markdown: "original", text: "original" };
  const persist = vi.fn(async (value: typeof initial) => value);
  const view = render(<HomeQuickNote identity="review-final-check" scope={scope} editorControllerRef={controllerRef}
    initialValue={initial} records={[]} persist={persist} commit={async () => ({})} onClear={() => {}}
    renderEditor={options => <RichEditor variant="bare" html={initial.html} controllerRef={options.controllerRef}
      onSave={options.onSave} onChange={options.onChange} onPersistStateChange={options.onPersistStateChange}
      autosave={{ delay: 120000 }} />} />);
  await waitFor(() => expect(controllerRef.current).not.toBeNull());
  await act(async () => { await flushQuickNotes(scope); });
  expect(() => assertQuickNotesSaved(scope)).not.toThrow();
  const surface = view.container.querySelector(".ProseMirror");
  act(() => controllerRef.current!.focus("end"));
  await user.keyboard(" LATE INPUT");
  expect(() => assertQuickNotesSaved(scope)).toThrow("QuickNote 仍有未保存的修改");
  expect(view.container.querySelector(".ProseMirror")).toBe(surface);
  expect(surface).toHaveTextContent("LATE INPUT");
  await act(async () => { await flushQuickNotes(scope); });
  expect(() => assertQuickNotesSaved(scope)).not.toThrow();
  expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: expect.stringContaining("LATE INPUT") }));
  view.unmount();
});

it("retains a real QuickNote draft while nested shutdown holds block editing and releases restore it", async () => {
  const controllerRef = { current: null as RichEditorController | null };
  const initial = { html: "<p>original</p>", markdown: "original", text: "original" };
  const persist = vi.fn(async (value: typeof initial) => value);
  const first = holdQuickNotes();
  const view = render(<HomeQuickNote identity="review-shutdown-hold" editorControllerRef={controllerRef}
    initialValue={initial} records={[]} persist={persist} commit={async () => ({})} onClear={() => {}}
    renderEditor={options => <RichEditor variant="bare" html={initial.html} controllerRef={options.controllerRef}
      readOnly={options.readOnly} onSave={options.onSave} autosave={{ delay: 120000 }} />} />);
  let second = () => {};
  try {
    await waitFor(() => expect(controllerRef.current).not.toBeNull());
    const section = view.container.querySelector<HTMLElement>(".home-quick-note")!;
    const surface = view.container.querySelector(".ProseMirror")!;
    expect(section.inert).toBe(true);
    expect(surface).toHaveAttribute("contenteditable", "false");
    second = holdQuickNotes();
    first();
    expect(section.inert).toBe(true);
    await act(async () => { await flushQuickNotes(); });
    expect(controllerRef.current!.getCommittedValue().markdown).toBe("original");
    act(() => second());
    expect(section.inert).toBe(false);
    expect(surface).toHaveAttribute("contenteditable", "true");
    act(() => controllerRef.current!.focus("end"));
    await userEvent.setup().keyboard(" AFTER ABORT");
    await act(async () => { await flushQuickNotes(); });
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: expect.stringContaining("AFTER ABORT") }));
    expect(view.container.querySelector(".ProseMirror")).toBe(surface);
  } finally { first(); second(); view.unmount(); }
});

it.each(["close", "hide", "hold"] as const)("retains pending browser DOM input across immediate %s and failed persistence", async (transition) => {
  const scope = { workspaceRoot: "/pending-browser-input", projectId: 1 };
  const controllerRef = { current: null as RichEditorController | null };
  const initial = { html: "<p>original</p>", markdown: "original", text: "original" };
  let failing = true;
  const persist = vi.fn(async (value: typeof initial) => {
    if (failing) throw new Error("native save rejection");
    return value;
  });
  const ui = (visible: boolean) => <HomeQuickNote identity="pending-browser-input" scope={scope}
    editorControllerRef={controllerRef} initialValue={initial} records={[]} persist={persist}
    commit={async () => ({})} onClear={() => {}}
    renderEditor={options => <RichEditor variant="bare" html={initial.html} controllerRef={options.controllerRef}
      readOnly={!visible || options.readOnly} onSave={options.onSave} onChange={options.onChange}
      onPersistStateChange={options.onPersistStateChange} autosave={{ delay: 120000, onBlur: true }} />} />;
  const view = render(ui(true));
  let release = () => {};
  try {
    await waitFor(() => expect(controllerRef.current).not.toBeNull());
    const surface = view.container.querySelector<HTMLElement>(".ProseMirror")!;
    const button = view.container.querySelector<HTMLButtonElement>('button[aria-label="展开 QuickNote"]')!;
    let saving!: Promise<void>;
    act(() => {
      surface.focus();
      // A browser edit changes DOM before MutationObserver has delivered it to PM.
      surface.querySelector("p")!.firstChild!.textContent = "original PENDING DOM";
      button.focus(); // PM blur queues the unread mutations on its 20ms timer.
      if (transition === "hold") release = holdQuickNotes();
      if (transition === "hide") flushSync(() => view.rerender(ui(false)));
      saving = flushQuickNotes(scope); // Deliberately no await since the DOM edit.
    });
    await act(async () => { await expect(saving).rejects.toThrow("native save rejection"); });
    expect(view.container.querySelector(".ProseMirror")).toBe(surface);
    expect(surface).toHaveTextContent("original PENDING DOM");
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "original PENDING DOM" }));
    failing = false;
    await act(async () => { await flushQuickNotes(scope); });
    expect(controllerRef.current!.hasUnsavedCommittedContent()).toBe(false);
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "original PENDING DOM" }));
    act(() => { release(); view.rerender(ui(true)); });
    expect(surface).toHaveAttribute("contenteditable", "true");
    expect(surface).toHaveTextContent("original PENDING DOM");
  } finally { release(); view.unmount(); }
});

it.each(["hide", "hold", "hold-through-end"] as const)("fails closed during composition across %s without ending or discarding input", async (transition) => {
  const scope = { workspaceRoot: "/composing-browser-input", projectId: 1 };
  const controllerRef = { current: null as RichEditorController | null };
  const initial = { html: "<p>original</p>", markdown: "original", text: "original" };
  const persist = vi.fn(async (value: typeof initial) => value);
  const ui = (visible: boolean) => <HomeQuickNote identity="composing-browser-input" scope={scope}
    editorControllerRef={controllerRef} initialValue={initial} records={[]} persist={persist}
    commit={async () => ({})} onClear={() => {}}
    renderEditor={options => <RichEditor variant="bare" html={initial.html} controllerRef={options.controllerRef}
      readOnly={!visible || options.readOnly} onSave={options.onSave} onChange={options.onChange}
      onPersistStateChange={options.onPersistStateChange} autosave={{ delay: 120000 }} />} />;
  const view = render(ui(true));
  let release = () => {};
  try {
    await waitFor(() => expect(controllerRef.current).not.toBeNull());
    const surface = view.container.querySelector<HTMLElement>(".ProseMirror")!;
    act(() => {
      surface.focus();
      fireEvent.compositionStart(surface);
      surface.querySelector("p")!.firstChild!.textContent = "original 输入";
      if (transition !== "hide") release = holdQuickNotes();
      else flushSync(() => view.rerender(ui(false)));
    });
    // Let readonly effects and PM's delayed work run while the real IME session
    // remains open: a hold must not implicitly finish that session.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    await act(async () => { await expect(flushQuickNotes(scope)).rejects.toThrow("正在输入"); });
    expect(persist).not.toHaveBeenCalled();
    expect(surface).toHaveAttribute("contenteditable", "true");
    expect(surface).toHaveTextContent("original 输入");
    expect(() => assertQuickNotesSaved(scope)).toThrow("未保存");
    if (transition !== "hold-through-end") {
      act(() => { release(); view.rerender(ui(true)); });
      await act(async () => { await expect(flushQuickNotes(scope)).rejects.toThrow("正在输入"); });
    }
    act(() => fireEvent.compositionEnd(surface));
    await act(async () => { await flushQuickNotes(scope); });
    if (transition === "hold-through-end") {
      expect(surface).toHaveAttribute("contenteditable", "false");
      act(() => release());
    }
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "original 输入" }));
    expect(view.container.querySelector(".ProseMirror")).toBe(surface);
    expect(surface).toHaveAttribute("contenteditable", "true");
    act(() => controllerRef.current!.focus("end"));
    await userEvent.setup().keyboard(" AFTER ABORT");
    await act(async () => { await flushQuickNotes(scope); });
    expect(persist).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: "original 输入 AFTER ABORT" }));
  } finally { release(); view.unmount(); }
});

beforeAll(() => {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 24,
    right: 240,
    width: 240,
    height: 24,
    toJSON: () => ({}),
  } satisfies DOMRect;
  const createRectList = () =>
    ({
      0: rect,
      length: 1,
      item: (index: number) => (index === 0 ? rect : null),
      [Symbol.iterator]: function* iterator() {
        yield rect;
      },
    }) as DOMRectList;

  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => null,
  });
  Object.defineProperty(window, "scrollBy", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: createRectList,
  });
  Object.defineProperty(Text.prototype, "getClientRects", {
    configurable: true,
    value: createRectList,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: createRectList,
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(() => true),
  });
});
