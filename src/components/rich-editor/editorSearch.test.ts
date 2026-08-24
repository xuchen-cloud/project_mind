import { afterEach, describe, expect, it, vi } from "vitest";

import { scrollSearchMatchIntoComfortView } from "./editorSearch";

function createEditor(dom: HTMLElement) {
  return {
    isDestroyed: false,
    view: {
      dom,
      coordsAtPos: () => ({ top: 900, bottom: 920 }),
    },
  } as never;
}

describe("scrollSearchMatchIntoComfortView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("positions a keyboard search match immediately inside a scroll container", () => {
    const scrollParent = document.createElement("div");
    const editorDom = document.createElement("div");
    scrollParent.append(editorDom);
    document.body.append(scrollParent);
    Object.defineProperties(scrollParent, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
    });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      overflow: "auto",
      overflowY: "auto",
    } as CSSStyleDeclaration);
    vi.spyOn(scrollParent, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 400,
    } as DOMRect);
    const scrollBy = vi.fn();
    scrollParent.scrollBy = scrollBy;

    scrollSearchMatchIntoComfortView(createEditor(editorDom), 1);

    expect(scrollBy).toHaveBeenCalledWith({ top: 742, behavior: "auto" });
  });

  it("positions a keyboard search match immediately in the window", () => {
    const editorDom = document.createElement("div");
    document.body.append(editorDom);
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      overflow: "visible",
      overflowY: "visible",
    } as CSSStyleDeclaration);
    vi.stubGlobal("innerHeight", 800);
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);

    scrollSearchMatchIntoComfortView(createEditor(editorDom), 1);

    expect(scrollBy).toHaveBeenCalledWith({ top: 574, behavior: "auto" });
  });
});
