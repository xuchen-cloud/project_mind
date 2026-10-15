import { createRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TabStripScroll } from "./TabStripScroll";

const observers: TestResizeObserver[] = [];
class TestResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: () => void) { observers.push(this); }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  // jsdom lacks PointerEvent and pointer capture; preserve coordinates and IDs.
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) {
      super(type, options);
      this.pointerId = options.pointerId ?? 0;
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

function fixture(width = 100, contentWidth = 400, existingId = "", existingClass = "") {
  const ref = createRef<HTMLDivElement>();
  const sizes = { width, contentWidth };
  function ui(contentKey: string, viewportId?: string, show = true) {
    return <div className="tab-strip-frame">
      <div id={existingId || undefined} className={existingClass} ref={node => {
        ref.current = node;
        if (node) Object.defineProperties(node, {
          clientWidth: { configurable: true, get: () => sizes.width },
          scrollWidth: { configurable: true, get: () => sizes.contentWidth },
        });
      }}>
        <div key={contentKey}><button>Tab</button></div>
      </div>
      {show && <TabStripScroll viewportRef={ref} contentKey={contentKey} ariaLabel="项目页签滚动" viewportId={viewportId} />}
    </div>;
  }
  const view = render(ui("initial"));
  return {
    ...view, ref, sizes,
    viewport: ref.current!,
    change: (key: string, id?: string, show = true) => view.rerender(ui(key, id, show)),
    resize: () => act(() => observers.at(-1)!.callback()),
  };
}

function thumb() { return screen.getByRole("scrollbar").firstElementChild as HTMLElement; }

function capture(track: HTMLElement) {
  let pointer: number | undefined;
  const set = vi.fn((id: number) => { pointer = id; });
  const release = vi.fn(() => { pointer = undefined; });
  Object.assign(track, {
    setPointerCapture: set,
    hasPointerCapture: (id: number) => pointer === id,
    releasePointerCapture: release,
  });
  return { set, release };
}

it("observes the real viewport and inner list, rendering no scrollbar without overflow", () => {
  const f = fixture(100, 100);
  expect(screen.queryByRole("scrollbar")).toBeNull();
  expect(f.viewport).toHaveClass("tab-strip-viewport");
  expect(observers[0].observe.mock.calls.map(([node]) => node)).toEqual([f.viewport, f.viewport.firstElementChild]);
  f.sizes.contentWidth = 400;
  f.resize();
  const track = screen.getByRole("scrollbar", { name: "项目页签滚动" });
  expect(track).toHaveAttribute("aria-orientation", "horizontal");
  expect(track).toHaveAttribute("aria-controls", f.viewport.id);
  expect(track).toHaveAttribute("aria-valuemin", "0");
  expect(track).toHaveAttribute("aria-valuemax", "300");
  expect(track).toHaveStyle({ width: "100px" });
  expect(thumb()).toHaveStyle({ width: "25px", transform: "translateX(0px)" });
});

it("follows native scroll continuously in both directions and clamps overscroll", () => {
  const f = fixture();
  for (const [position, offset, value] of [[150, 37.5, 150], [300, 75, 300], [60, 15, 60], [-12, 0, 0], [330, 75, 300]]) {
    f.viewport.scrollLeft = position;
    fireEvent.scroll(f.viewport);
    expect(thumb().style.transform).toBe(`translateX(${offset}px)`);
    expect(screen.getByRole("scrollbar")).toHaveAttribute("aria-valuenow", String(value));
  }
});

it("remeasures size and content changes, limits the minimum thumb to the viewport and removes exhausted overflow", () => {
  const f = fixture(100, 1000);
  expect(thumb()).toHaveStyle({ width: "20px" });
  f.sizes.width = 200;
  f.resize();
  expect(thumb()).toHaveStyle({ width: "40px" });
  const previousContent = f.viewport.firstElementChild;
  f.sizes.contentWidth = 400;
  f.change("new tabs");
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
  expect(f.viewport.firstElementChild).not.toBe(previousContent);
  expect(observers[1].observe).toHaveBeenCalledWith(f.viewport.firstElementChild);
  expect(thumb()).toHaveStyle({ width: "100px" });
  f.sizes.width = 12;
  f.resize();
  expect(thumb()).toHaveStyle({ width: "12px" });
  f.sizes.contentWidth = 12;
  f.resize();
  expect(screen.queryByRole("scrollbar")).toBeNull();
});

it("moves the real scrollLeft with arrows, Home and End without consuming unrelated keys", () => {
  const f = fixture();
  const track = screen.getByRole("scrollbar");
  for (const [key, position] of [["ArrowRight", 40], ["ArrowLeft", 0], ["ArrowLeft", 0], ["End", 300], ["ArrowRight", 300], ["Home", 0]] as const) {
    expect(fireEvent.keyDown(track, { key })).toBe(false);
    expect(f.viewport.scrollLeft).toBe(position);
    expect(track).toHaveAttribute("aria-valuenow", String(position));
  }
  expect(fireEvent.keyDown(track, { key: "Tab" })).toBe(true);
});

it("centers track clicks in local coordinates and leaves tab clicks alone", () => {
  const f = fixture();
  const track = screen.getByRole("scrollbar");
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({ left: 200 } as DOMRect);
  fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 250 });
  expect(f.viewport.scrollLeft).toBe(150);
  expect(track).toHaveFocus();
  fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 200 });
  expect(f.viewport.scrollLeft).toBe(0);
  fireEvent.pointerDown(track, { button: 0, pointerId: 1, clientX: 300 });
  expect(f.viewport.scrollLeft).toBe(300);
  fireEvent.pointerDown(track, { button: 2, pointerId: 1, clientX: 250 });
  fireEvent.click(screen.getByRole("button", { name: "Tab" }));
  expect(f.viewport.scrollLeft).toBe(300);
});

it("captures thumb drags, ignores other pointers and stops on pointercancel or pointerup", () => {
  const f = fixture();
  const track = screen.getByRole("scrollbar");
  const { set, release } = capture(track);
  fireEvent.pointerDown(thumb(), { button: 0, pointerId: 7, clientX: 10 });
  expect(set).toHaveBeenCalledWith(7);
  expect(track).toHaveAttribute("data-dragging", "true");
  fireEvent.pointerMove(track, { pointerId: 8, clientX: 70 });
  fireEvent.pointerCancel(track, { pointerId: 8 });
  expect(f.viewport.scrollLeft).toBe(0);
  expect(track).toHaveAttribute("data-dragging", "true");
  fireEvent.pointerMove(track, { pointerId: 7, clientX: 47.5 });
  expect(f.viewport.scrollLeft).toBe(150);
  fireEvent.pointerMove(track, { pointerId: 7, clientX: 25 });
  expect(f.viewport.scrollLeft).toBe(60);
  fireEvent.pointerCancel(track, { pointerId: 7 });
  expect(release).toHaveBeenCalledWith(7);
  expect(track).not.toHaveAttribute("data-dragging");
  fireEvent.pointerMove(track, { pointerId: 7, clientX: 100 });
  expect(f.viewport.scrollLeft).toBe(60);
  fireEvent.pointerDown(thumb(), { button: 0, pointerId: 9, clientX: 25 });
  fireEvent.pointerUp(track, { pointerId: 9 });
  expect(release).toHaveBeenCalledWith(9);
  expect(track).not.toHaveAttribute("data-dragging");
});

it("cleans up active drag on lost capture, disappearing overflow and unmount", () => {
  const f = fixture();
  const track = screen.getByRole("scrollbar");
  const { release } = capture(track);
  fireEvent.pointerDown(thumb(), { button: 0, pointerId: 2, clientX: 0 });
  fireEvent.lostPointerCapture(track, { pointerId: 2 });
  expect(track).not.toHaveAttribute("data-dragging");
  fireEvent.pointerDown(thumb(), { button: 0, pointerId: 3, clientX: 0 });
  f.sizes.contentWidth = 100;
  f.resize();
  expect(release).toHaveBeenCalledWith(3);
  expect(screen.queryByRole("scrollbar")).toBeNull();
  f.sizes.contentWidth = 400;
  f.resize();
  const newTrack = screen.getByRole("scrollbar");
  const newCapture = capture(newTrack);
  fireEvent.pointerDown(thumb(), { button: 0, pointerId: 4, clientX: 0 });
  f.change("initial", undefined, false);
  expect(newCapture.release).toHaveBeenCalledWith(4);
  expect(observers[0].disconnect).toHaveBeenCalledOnce();
  expect(f.viewport).not.toHaveClass("tab-strip-viewport");
  expect(f.viewport).not.toHaveAttribute("id");
});

it("honors explicit aria-controls and preserves parent IDs, classes and scroll listeners on cleanup", () => {
  const f = fixture(100, 400, "parent-tabs", "tab-strip-viewport");
  const parentScroll = vi.fn();
  f.viewport.addEventListener("scroll", parentScroll);
  const remove = vi.spyOn(f.viewport, "removeEventListener");
  f.change("initial", "content-tabs");
  expect(screen.getByRole("scrollbar")).toHaveAttribute("aria-controls", "content-tabs");
  expect(f.viewport).toHaveAttribute("id", "content-tabs");
  f.change("initial", "content-tabs", false);
  expect(f.viewport).toHaveAttribute("id", "parent-tabs");
  expect(f.viewport).toHaveClass("tab-strip-viewport");
  expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  fireEvent.scroll(f.viewport);
  expect(parentScroll).toHaveBeenCalledOnce();
});
