import { act, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, expect, it, vi } from "vitest";
import { HomeQuickNote } from "./HomeQuickNote";
import { RichEditor, type RichEditorController } from "../rich-editor/RichEditor";
import { flushQuickNotes } from "../../lib/quick-note-transfer";

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
