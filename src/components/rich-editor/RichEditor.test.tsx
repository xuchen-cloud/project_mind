import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Copy } from "lucide-react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as aiJobs from "../../lib/aiJobs";
import { buildInternalReferenceHtml } from "../../lib/internalReferences";
import { projectMindApi } from "../../services/projectMindApi";
import { desktopApi } from "../../services/desktopApi";
import { useAiJobStore } from "../../state/ai-job-store";
import { clearManagedImageThumbnailCacheForTests } from "./imageThumbnails";
import { RichEditor } from "./RichEditor";

const intersectionObservers: Array<{
  callback: IntersectionObserverCallback;
  elements: Set<Element>;
}> = [];
let defaultIntersectionState = true;

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
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ({
      canvas: document.createElement("canvas"),
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray() })),
      putImageData: vi.fn(),
      createImageData: vi.fn(() => []),
      setTransform: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      fillText: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      stroke: vi.fn(),
      fill: vi.fn(),
      arc: vi.fn(),
      ellipse: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      measureText: vi.fn(() => ({
        width: 120,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 4,
      })),
      transform: vi.fn(),
      resetTransform: vi.fn(),
      setLineDash: vi.fn(),
      strokeText: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      createPattern: vi.fn(() => null),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    }),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: () => "data:image/png;base64,AAAA",
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class IntersectionObserver {
      #callback: IntersectionObserverCallback;
      #elements = new Set<Element>();

      constructor(callback: IntersectionObserverCallback) {
        this.#callback = callback;
        intersectionObservers.push({
          callback,
          elements: this.#elements,
        });
      }

      observe = (element: Element) => {
        this.#elements.add(element);
        this.#callback(
          [
            {
              isIntersecting: defaultIntersectionState,
              intersectionRatio: defaultIntersectionState ? 1 : 0,
              target: element,
            } as IntersectionObserverEntry,
          ],
          this as unknown as IntersectionObserver,
        );
      };

      unobserve = (element: Element) => {
        this.#elements.delete(element);
      };

      disconnect = () => {
        this.#elements.clear();
      };

      takeRecords = () => [];
      root = null;
      rootMargin = "0px";
      thresholds = [];
    },
  });
  Object.defineProperty(window, "Image", {
    configurable: true,
    writable: true,
    value: class MockImage {
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      naturalWidth = 1600;
      naturalHeight = 900;
      width = 1600;
      height = 900;
      decoding = "async";
      #src = "";

      get src() {
        return this.#src;
      }

      set src(value: string) {
        this.#src = value;
        queueMicrotask(() => {
          this.onload?.();
        });
      }
    },
  });
  Object.defineProperty(globalThis, "Image", {
    configurable: true,
    writable: true,
    value: window.Image,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      const styleWidth = Number.parseFloat(
        this.style.width || this.style.minWidth || this.getAttribute("width") || "0",
      );

      if (Number.isFinite(styleWidth) && styleWidth > 0) {
        return styleWidth;
      }

      return this.tagName === "IMG" ? 240 : 48;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      const styleHeight = Number.parseFloat(this.style.height || this.getAttribute("height") || "0");

      if (Number.isFinite(styleHeight) && styleHeight > 0) {
        return styleHeight;
      }

      return this.tagName === "IMG" ? 160 : 48;
    },
  });
  vi.spyOn(desktopApi, "toFileUrl").mockImplementation((path) => `asset://${path}`);
  vi.spyOn(desktopApi, "readFileAsDataUrl").mockImplementation(async (path, mimeType) => {
    const resolvedMimeType = mimeType || "image/png";
    return `data:${resolvedMimeType};base64,${btoa(path)}`;
  });
  vi.spyOn(desktopApi, "generateImageThumbnail").mockImplementation(async (path, maxEdge) => {
    return `${path}.${maxEdge}.thumb.jpg`;
  });
});

beforeEach(() => {
  clearManagedImageThumbnailCacheForTests();
  useAiJobStore.getState().reset();
  defaultIntersectionState = true;
  intersectionObservers.length = 0;
});

function getLatestHtml(onChange: ReturnType<typeof vi.fn>) {
  return onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]?.html as string | undefined;
}

async function getEditorSurface(container: HTMLElement) {
  return waitFor(() => {
    const nextSurface = container.querySelector(".rich-editor__surface");

    expect(nextSurface).toBeTruthy();
    return nextSurface as HTMLElement;
  });
}

function triggerIntersection(isIntersecting: boolean) {
  defaultIntersectionState = isIntersecting;

  for (const observer of intersectionObservers) {
    for (const element of observer.elements) {
      observer.callback(
        [
          {
            isIntersecting,
            intersectionRatio: isIntersecting ? 1 : 0,
            target: element,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    }
  }
}

function selectTextContent(node: Text, start: number, end: number) {
  const selection = window.getSelection();
  const range = document.createRange();

  range.setStart(node, start);
  range.setEnd(node, end);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function selectTextRange(startNode: Text, startOffset: number, endNode: Text, endOffset: number) {
  const selection = window.getSelection();
  const range = document.createRange();

  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

function clearBrowserSelection() {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  document.dispatchEvent(new Event("selectionchange"));
}

describe("RichEditor tables", () => {
  it("inserts a selected table size and reveals the table toolbar", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<RichEditor variant="toolbar" onChange={onChange} />);

    await user.click(await screen.findByLabelText("表格"));
    await user.click(screen.getByLabelText("插入 2 行 4 列表格"));

    await waitFor(() => {
      expect(container.querySelectorAll("table tr")).toHaveLength(2);
    });

    expect(container.querySelectorAll("table tr")[0]?.querySelectorAll("th")).toHaveLength(4);
    expect(await screen.findByLabelText("表格工具栏")).toBeInTheDocument();
    expect(screen.getByLabelText("下方插入行")).toBeInTheDocument();
    expect(screen.getByLabelText("删除表格")).toBeInTheDocument();
    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
    });
  });

  it("adds rows from the contextual table toolbar", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="toolbar" />);

    await user.click(await screen.findByLabelText("表格"));
    await user.click(screen.getByLabelText("插入 2 行 2 列表格"));
    await user.click(await screen.findByLabelText("下方插入行"));

    await waitFor(() => {
      expect(container.querySelectorAll("table tr")).toHaveLength(3);
    });
  });

  it("renders the table toolbar inside the editor frame above the active table", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="toolbar" />);

    await user.click(await screen.findByLabelText("表格"));
    await user.click(screen.getByLabelText("插入 2 行 2 列表格"));

    const toolbar = await screen.findByLabelText("表格工具栏");
    const frame = container.querySelector(".rich-editor__frame");

    expect(frame).toBeTruthy();
    expect(toolbar.closest(".rich-editor__frame")).toBe(frame);
    expect(toolbar).toHaveClass("rich-editor__table-toolbar--floating");
  });

  it("shows a compact table action for focused bare editors", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="bare" />);

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".rich-editor__surface");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    fireEvent.focus(surface);
    fireEvent.contextMenu(surface, { clientX: 20, clientY: 20 });
    const menu = await screen.findByRole("menu", { name: "文本操作" });
    await user.click(within(menu).getByRole("menuitem", { name: "插入表格" }));

    await waitFor(() => {
      expect(container.querySelectorAll("table tr")).toHaveLength(3);
    });
  });

  it("hides the compact table action when tables are disabled", async () => {
    const { container } = render(<RichEditor variant="bare" enableTables={false} />);

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".rich-editor__surface");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    fireEvent.focus(surface);

    expect(screen.queryByRole("button", { name: "插入表格" })).not.toBeInTheDocument();
  });

  it("supports resizing the whole table with the corner handle", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RichEditor variant="toolbar" onChange={onChange} />);

    await user.click(await screen.findByLabelText("表格"));
    await user.click(screen.getByLabelText("插入 2 行 2 列表格"));

    const resizeHandle = await screen.findByLabelText("调整表格大小");

    fireEvent.mouseDown(resizeHandle, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 120, clientY: 0 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      const html = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]?.html as string | undefined;

      expect(html).toContain('style="width: 216px;"');
    });
  });

  it("uses a compact minimum width for table columns", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="toolbar" />);

    await user.click(await screen.findByLabelText("表格"));
    await user.click(screen.getByLabelText("插入 2 行 2 列表格"));

    await waitFor(() => {
      expect(container.querySelector("col")?.style.minWidth).toBe("48px");
      expect(container.querySelector("table")?.style.minWidth).toBe("96px");
    });
  });

  it("pastes html tables from clipboard rich content", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<RichEditor variant="toolbar" onChange={onChange} />);
    const surface = await getEditorSurface(container);

    await user.click(surface);
    fireEvent.paste(surface, {
      clipboardData: {
        files: [],
        items: [],
        getData: (type: string) =>
          type === "text/html"
            ? '<table class="MsoNormalTable" style="mso-cellspacing:1.5pt"><tbody><tr><td>客户</td><td>状态</td></tr><tr><td>ACME</td><td>跟进中</td></tr></tbody></table>'
            : "客户\t状态",
      },
    });

    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });

    expect(container.querySelectorAll("table tr")).toHaveLength(2);
    await waitFor(() => {
      expect(getLatestHtml(onChange)).toContain("<table");
    });
  });
});

describe("RichEditor images", () => {
  it("renders image resize controls and updates width", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const pickFileSpy = vi.spyOn(desktopApi, "pickFile").mockResolvedValue("/tmp/clip.png");
    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        assetHandlers={{
          insertImage: async () => ({
            kind: "image",
            title: "clip.png",
            src: "data:image/png;base64,AA==",
          }),
        }}
      />,
    );

    await user.click(await screen.findByLabelText("图片"));

    await waitFor(() => {
      expect(container.querySelector("img.rich-editor__image")).toBeTruthy();
    });

    const resizeHandle = await screen.findByLabelText("调整图片大小");

    fireEvent.mouseDown(resizeHandle, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 80, clientY: 0 });
    fireEvent.mouseUp(document);

    await waitFor(() => {
      const html = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0]?.html as string | undefined;

      expect(html).toContain('width="320"');
    });

    pickFileSpy.mockRestore();
  });

  it("keeps inserted managed images as file-backed refs while preserving the file path", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const pickFileSpy = vi.spyOn(desktopApi, "pickFile").mockResolvedValue("/tmp/clip.png");
    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        assetHandlers={{
          insertImage: async () => ({
            kind: "image",
            title: "clip.png",
            path: "/tmp/managed/clip.png",
            mimeType: "image/png",
          }),
        }}
      />,
    );

    await user.click(await screen.findByLabelText("图片"));

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img.rich-editor__image");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    await waitFor(() => {
      expect(image.getAttribute("src")).toBe(
        "asset:///tmp/managed/clip.png.960.thumb.jpg",
      );
    });

    await waitFor(() => {
      const html = getLatestHtml(onChange);

      expect(html).toContain('src="asset:///tmp/managed/clip.png"');
      expect(html).toContain('data-path="/tmp/managed/clip.png"');
    });

    pickFileSpy.mockRestore();
  });

  it("clamps managed image display width to the editor surface during window resizing", async () => {
    const resizeObservers: Array<{
      callback: ResizeObserverCallback;
      elements: Set<Element>;
    }> = [];
    const OriginalResizeObserver = globalThis.ResizeObserver;

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        #callback: ResizeObserverCallback;
        #elements = new Set<Element>();

        constructor(callback: ResizeObserverCallback) {
          this.#callback = callback;
          resizeObservers.push({
            callback,
            elements: this.#elements,
          });
        }

        observe = (element: Element) => {
          this.#elements.add(element);
        };

        unobserve = (element: Element) => {
          this.#elements.delete(element);
        };

        disconnect = () => {
          this.#elements.clear();
        };
      },
    });

    try {
      const { container } = render(
        <RichEditor
          variant="bare"
          defaultHtml='<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" width="360" alt="截图" /></p>'
        />,
      );

      const surface = await waitFor(() => {
        const nextSurface = container.querySelector(".rich-editor__surface");

        expect(nextSurface).toBeTruthy();
        return nextSurface as HTMLElement;
      });

      let mockSurfaceWidth = 220;
      Object.defineProperty(surface, "clientWidth", {
        configurable: true,
        get: () => mockSurfaceWidth,
      });

      const image = await waitFor(() => {
        const nextImage = container.querySelector("img.rich-editor__image");

        expect(nextImage).toBeTruthy();
        return nextImage as HTMLImageElement;
      });

      for (const observer of resizeObservers) {
        observer.callback([], {} as ResizeObserver);
      }

      await waitFor(() => {
        expect(image.style.width).toBe("220px");
      });

      mockSurfaceWidth = 480;
      for (const observer of resizeObservers) {
        observer.callback([], {} as ResizeObserver);
      }

      await waitFor(() => {
        expect(image.style.width).toBe("360px");
      });
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: OriginalResizeObserver,
      });
    }
  });

  it("does not rewrite the image source during resize-only width syncs", async () => {
    const resizeObservers: Array<{
      callback: ResizeObserverCallback;
      elements: Set<Element>;
    }> = [];
    const OriginalResizeObserver = globalThis.ResizeObserver;

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: class ResizeObserver {
        #callback: ResizeObserverCallback;
        #elements = new Set<Element>();

        constructor(callback: ResizeObserverCallback) {
          this.#callback = callback;
          resizeObservers.push({
            callback,
            elements: this.#elements,
          });
        }

        observe = (element: Element) => {
          this.#elements.add(element);
        };

        unobserve = (element: Element) => {
          this.#elements.delete(element);
        };

        disconnect = () => {
          this.#elements.clear();
        };
      },
    });

    try {
      const { container } = render(
        <RichEditor
          variant="bare"
          defaultHtml='<p><img src="asset:///tmp/managed/stable.png" data-path="/tmp/managed/stable.png" data-mime-type="image/png" width="360" alt="稳定图片" /></p>'
        />,
      );

      const surface = await waitFor(() => {
        const nextSurface = container.querySelector(".rich-editor__surface");

        expect(nextSurface).toBeTruthy();
        return nextSurface as HTMLElement;
      });

      let mockSurfaceWidth = 240;
      Object.defineProperty(surface, "clientWidth", {
        configurable: true,
        get: () => mockSurfaceWidth,
      });

      const image = await waitFor(() => {
        const nextImage = container.querySelector("img.rich-editor__image");

        expect(nextImage).toBeTruthy();
        return nextImage as HTMLImageElement;
      });

      const setAttributeSpy = vi.spyOn(image, "setAttribute");

      for (const observer of resizeObservers) {
        observer.callback([], {} as ResizeObserver);
      }

      await waitFor(() => {
        expect(image.style.width).toBe("240px");
      });

      expect(
        setAttributeSpy.mock.calls.filter(([name]) => name === "src"),
      ).toHaveLength(0);

      setAttributeSpy.mockRestore();
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: OriginalResizeObserver,
      });
    }
  });

  it("keeps managed images responsive on window resize even without ResizeObserver support", async () => {
    const OriginalResizeObserver = globalThis.ResizeObserver;

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: undefined,
    });

    try {
      const { container } = render(
        <RichEditor
          variant="bare"
          defaultHtml='<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" width="360" alt="截图" /></p>'
        />,
      );

      const surface = await waitFor(() => {
        const nextSurface = container.querySelector(".rich-editor__surface");

        expect(nextSurface).toBeTruthy();
        return nextSurface as HTMLElement;
      });

      let mockSurfaceWidth = 220;
      Object.defineProperty(surface, "clientWidth", {
        configurable: true,
        get: () => mockSurfaceWidth,
      });

      const image = await waitFor(() => {
        const nextImage = container.querySelector("img.rich-editor__image");

        expect(nextImage).toBeTruthy();
        return nextImage as HTMLImageElement;
      });

      fireEvent(window, new Event("resize"));

      await waitFor(() => {
        expect(image.style.width).toBe("220px");
      });

      mockSurfaceWidth = 480;
      fireEvent(window, new Event("resize"));

      await waitFor(() => {
        expect(image.style.width).toBe("360px");
      });
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: OriginalResizeObserver,
      });
    }
  });

  it("keeps embedded file-inserted images in the save payload and after reopening", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (value: { html: string }) => value);
    const pickFileSpy = vi.spyOn(desktopApi, "pickFile").mockResolvedValue("/tmp/clip.png");
    let savedHtml = "";
    const { container, unmount } = render(
      <RichEditor
        variant="toolbar"
        onSave={async (value) => {
          savedHtml = value.html;
          return onSave(value);
        }}
        renderToolbarExtras={({ save }) => (
          <button type="button" onClick={() => void save({ force: true })}>
            触发保存
          </button>
        )}
        assetHandlers={{
          insertImage: async () => ({
            kind: "image",
            title: "clip.png",
            path: "/tmp/managed/clip.png",
            mimeType: "image/png",
          }),
        }}
      />,
    );

    await user.click(await screen.findByLabelText("图片"));
    await user.click(await screen.findByRole("button", { name: "触发保存" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
      expect(savedHtml).toContain('src="asset:///tmp/managed/clip.png"');
      expect(savedHtml).toContain('data-path="/tmp/managed/clip.png"');
    });

    unmount();
    const reopened = render(<RichEditor variant="toolbar" defaultHtml={savedHtml} />);

    const image = await waitFor(() => {
      const nextImage = reopened.container.querySelector("img");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    await waitFor(() => {
      expect(image.getAttribute("src")).toBe(
        "asset:///tmp/managed/clip.png.960.thumb.jpg",
      );
    });
    pickFileSpy.mockRestore();
  });

  it("keeps embedded data-url images in the save payload and after reopening", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (value: { html: string }) => value);
    let savedHtml = "";
    const sourceHtml =
      '<p><img src="data:image/png;base64,AAAA" data-path="/tmp/managed/clipboard.png" data-mime-type="image/png" alt="clipboard.png"></p>';
    const { unmount } = render(
      <RichEditor
        variant="toolbar"
        defaultHtml={sourceHtml}
        onSave={async (value) => {
          savedHtml = value.html;
          return onSave(value);
        }}
        renderToolbarExtras={({ save }) => (
          <button type="button" onClick={() => void save({ force: true })}>
            触发保存
          </button>
        )}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "触发保存" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalled();
      expect(savedHtml).toContain('src="asset:///tmp/managed/clipboard.png"');
      expect(savedHtml).toContain('data-path="/tmp/managed/clipboard.png"');
    });

    unmount();
    const reopened = render(<RichEditor variant="toolbar" defaultHtml={savedHtml} />);

    const image = await waitFor(() => {
      const nextImage = reopened.container.querySelector("img");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    await waitFor(() => {
      expect(image.getAttribute("src")).toBe(
        "asset:///tmp/managed/clipboard.png.960.thumb.jpg",
      );
    });
  });

  it("opens an image context menu and updates width from a preset", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const pickFileSpy = vi.spyOn(desktopApi, "pickFile").mockResolvedValue("/tmp/clip.png");
    const revealPathSpy = vi.spyOn(desktopApi, "revealPath").mockResolvedValue(undefined);
    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        assetHandlers={{
          insertImage: async () => ({
            kind: "image",
            title: "clip.png",
            path: "/tmp/clip.png",
            src: "data:image/png;base64,AA==",
          }),
        }}
      />,
    );

    await user.click(await screen.findByLabelText("图片"));

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img.rich-editor__image");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    await user.click(image);
    fireEvent.contextMenu(image, { clientX: 40, clientY: 48 });

    const imageMenu = await screen.findByRole("menu", { name: "图片操作" });
    expect(within(imageMenu).getByRole("menuitem", { name: /打开图片所在位置/i })).toBeEnabled();

    await user.click(within(imageMenu).getByRole("menuitem", { name: /中图/i }));

    await waitFor(() => {
      expect(getLatestHtml(onChange)).toContain('width="360"');
    });

    fireEvent.contextMenu(image, { clientX: 40, clientY: 48 });
    await user.click(await screen.findByRole("menuitem", { name: /打开图片所在位置/i }));

    expect(revealPathSpy).toHaveBeenCalledWith("/tmp/clip.png");
    pickFileSpy.mockRestore();
    revealPathSpy.mockRestore();
  });

  it("disables reveal location when the image has no source path", async () => {
    const user = userEvent.setup();
    const pickFileSpy = vi.spyOn(desktopApi, "pickFile").mockResolvedValue("/tmp/clip.png");
    const { container } = render(
      <RichEditor
        variant="toolbar"
        assetHandlers={{
          insertImage: async () => ({
            kind: "image",
            title: "clip.png",
            src: "data:image/png;base64,AA==",
          }),
        }}
      />,
    );

    await user.click(await screen.findByLabelText("图片"));

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img.rich-editor__image");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    await user.click(image);
    fireEvent.contextMenu(image, { clientX: 40, clientY: 48 });

    expect(await screen.findByRole("menuitem", { name: /打开图片所在位置/i })).toBeDisabled();
    pickFileSpy.mockRestore();
  });

  it("deletes an image from the context menu", async () => {
    const user = userEvent.setup();
    const pickFileSpy = vi.spyOn(desktopApi, "pickFile").mockResolvedValue("/tmp/clip.png");
    const { container } = render(
      <RichEditor
        variant="toolbar"
        assetHandlers={{
          insertImage: async () => ({
            kind: "image",
            title: "clip.png",
            src: "data:image/png;base64,AA==",
          }),
        }}
      />,
    );

    await user.click(await screen.findByLabelText("图片"));

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img.rich-editor__image");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    await user.click(image);
    fireEvent.contextMenu(image, { clientX: 40, clientY: 48 });
    await user.click(await screen.findByRole("menuitem", { name: /删除图片/i }));

    await waitFor(() => {
      expect(container.querySelector("img.rich-editor__image")).toBeNull();
    });
    pickFileSpy.mockRestore();
  });

  it("repairs stale image src values from the stored path when loading html", async () => {
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml={'<p><img src="/tmp/stale.png" data-path="/tmp/fixed.png" alt="图片" /></p>'}
      />,
    );

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img.rich-editor__image");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    await waitFor(() => {
      expect(image.getAttribute("src")).toBe("asset:///tmp/fixed.png.960.thumb.jpg");
    });
  });

  it("opens the image browser on double click and keeps saved annotation previews after reopening", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const pickFileSpy = vi.spyOn(desktopApi, "pickFile").mockResolvedValue("/tmp/clip.png");
    const { container, unmount } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        assetHandlers={{
          insertImage: async () => ({
            kind: "image",
            title: "clip.png",
            src: "data:image/png;base64,AA==",
          }),
        }}
      />,
    );

    await user.click(await screen.findByLabelText("图片"));

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img.rich-editor__image");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    fireEvent.doubleClick(image);
    expect(await screen.findByRole("dialog", { name: "clip.png" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "文字" }));

    const stageSurface = await waitFor(() => {
      const nextSurface = document.querySelector(".konvajs-content");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    Object.defineProperty(stageSurface, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        bottom: 640,
        right: 960,
        width: 960,
        height: 640,
        toJSON: () => ({}),
      }),
    });

    fireEvent.mouseDown(stageSurface, { clientX: 180, clientY: 160, buttons: 1 });
    fireEvent.mouseUp(stageSurface, { clientX: 180, clientY: 160, buttons: 1 });
    fireEvent.click(stageSurface, { clientX: 180, clientY: 160, buttons: 1 });

    const textarea = await screen.findByTestId("image-annotation-text-editor");
    await user.type(textarea, "放大看细节");
    fireEvent.blur(textarea);

    await waitFor(() => {
      expect(screen.queryByTestId("image-annotation-text-editor")).toBeNull();
    });

    await user.click(screen.getByRole("button", { name: "保存标注" }));

    let savedHtml = "";
    await waitFor(() => {
      savedHtml = getLatestHtml(onChange) || "";
      expect(savedHtml).toContain("data-annotation-state=");
      expect(container.querySelector(".rich-editor__annotation-preview")).toBeTruthy();
    });

    unmount();
    const reopened = render(<RichEditor variant="toolbar" defaultHtml={savedHtml} />);

    await waitFor(() => {
      expect(reopened.container.querySelector(".rich-editor__annotation-preview")).toBeTruthy();
    });

    pickFileSpy.mockRestore();
  });

  it("reads pasted images from clipboard items when files are empty", async () => {
    const user = userEvent.setup();
    const insertPastedImage = vi.fn(async () => ({
      kind: "image" as const,
      title: "pasted-image.png",
      path: "/tmp/managed/pasted-image.png",
      mimeType: "image/png",
      documentId: 12,
    }));
    const { container } = render(
      <RichEditor
        variant="toolbar"
        assetHandlers={{
          insertPastedImage,
        }}
      />,
    );
    const surface = await getEditorSurface(container);
    const pastedFile = new File(["fake"], "pasted-image.png", { type: "image/png" });

    await user.click(surface);
    fireEvent.paste(surface, {
      clipboardData: {
        files: [],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => pastedFile,
          },
        ],
        getData: () => "",
      },
    });

    await waitFor(() => {
      expect(insertPastedImage).toHaveBeenCalledWith(pastedFile);
    });
  });

  it("inserts a pasted image into an empty editor without requiring seed text", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const insertPastedImage = vi.fn(async (file: File) => {
      await Promise.resolve();

      return {
        kind: "image" as const,
        title: file.name,
        path: "/tmp/managed/empty-editor.png",
        mimeType: file.type || "image/png",
        documentId: 22,
      };
    });
    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        assetHandlers={{
          insertPastedImage,
        }}
      />,
    );
    const surface = await getEditorSurface(container);
    const pastedFile = new File(["fake"], "empty-editor.png", { type: "image/png" });

    await user.click(surface);
    fireEvent.paste(surface, {
      clipboardData: {
        files: [pastedFile],
        items: [],
        getData: () => "",
      },
    });

    await waitFor(() => {
      expect(insertPastedImage).toHaveBeenCalledWith(pastedFile);
    });
    await waitFor(() => {
      expect(getLatestHtml(onChange)).toContain('data-path="/tmp/managed/empty-editor.png"');
    });
  });

  it("imports pasted html data-url images through the clipboard handler", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const insertPastedImage = vi.fn(async (file: File) => ({
      kind: "image" as const,
      title: file.name,
      path: "/tmp/managed/html-paste.png",
      mimeType: file.type || "image/png",
      documentId: 18,
    }));
    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        assetHandlers={{
          insertPastedImage,
        }}
      />,
    );
    const surface = await getEditorSurface(container);

    await user.click(surface);
    fireEvent.paste(surface, {
      clipboardData: {
        files: [],
        items: [],
        getData: (type: string) =>
          type === "text/html"
            ? '<img src="data:image/png;base64,QUFBQQ==" alt="截图" />'
            : "",
      },
    });

    await waitFor(() => {
      expect(insertPastedImage).toHaveBeenCalledTimes(1);
    });

    const pastedFile = insertPastedImage.mock.calls[0]?.[0] as File;

    expect(pastedFile.type).toBe("image/png");
    await waitFor(() => {
      expect(getLatestHtml(onChange)).toContain('data-path="/tmp/managed/html-paste.png"');
    });
  });

  it("preserves heic format metadata for pasted html data-url images", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const insertPastedImage = vi.fn(async (file: File) => ({
      kind: "image" as const,
      title: file.name,
      path: "/tmp/managed/html-paste.heic",
      mimeType: file.type || "image/heic",
      documentId: 21,
    }));
    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        assetHandlers={{
          insertPastedImage,
        }}
      />,
    );
    const surface = await getEditorSurface(container);

    await user.click(surface);
    fireEvent.paste(surface, {
      clipboardData: {
        files: [],
        items: [],
        getData: (type: string) =>
          type === "text/html"
            ? '<img src="data:image/heic;base64,QUFBQQ==" />'
            : "",
      },
    });

    await waitFor(() => {
      expect(insertPastedImage).toHaveBeenCalledTimes(1);
    });

    const pastedFile = insertPastedImage.mock.calls[0]?.[0] as File;

    expect(pastedFile.type).toBe("image/heic");
    expect(pastedFile.name).toBe("clipboard-image-1.heic");
    await waitFor(() => {
      expect(getLatestHtml(onChange)).toContain('data-path="/tmp/managed/html-paste.heic"');
    });
  });
});

describe("RichEditor internal references", () => {
  it("opens the picker on [[ and inserts an internal reference token", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const searchSpy = vi
      .spyOn(projectMindApi, "internalReferenceSearch")
      .mockResolvedValue([
        {
          kind: "todo",
          id: 18,
          label: "推进预算审批",
          projectId: 1,
          activityId: 2,
          subtitle: "Alpha · Kickoff",
          updatedAt: "2026-04-06T10:00:00.000Z",
        },
      ]);
    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        internalReferences={{
          context: { scope: "project", projectId: 1 },
        }}
      />,
    );
    const surface = await getEditorSurface(container);

    await user.click(surface);
    await user.keyboard("[[[[");

    expect(await screen.findByRole("listbox", { name: "内部引用选择器" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /Todo.*推进预算审批/u })).toBeInTheDocument();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      const latestValue = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];

      expect(latestValue?.html).toContain('data-type="internal-reference"');
      expect(latestValue?.markdown).toContain("[[todo:18|推进预算审批]]");
    });

    searchSpy.mockRestore();
  });

  it("opens the picker on fullwidth 【【 and still inserts the normalized internal reference token", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const searchSpy = vi
      .spyOn(projectMindApi, "internalReferenceSearch")
      .mockResolvedValue([
        {
          kind: "document",
          id: 51,
          label: "project-brief.pdf",
          projectId: 1,
          activityId: 2,
          subtitle: "Alpha · Kickoff",
          updatedAt: "2026-04-06T10:00:00.000Z",
        },
      ]);
    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        internalReferences={{
          context: { scope: "project", projectId: 1 },
        }}
      />,
    );
    const surface = await getEditorSurface(container);

    await user.click(surface);
    await user.keyboard("【【");

    expect(await screen.findByRole("listbox", { name: "内部引用选择器" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /文件.*project-brief\.pdf/u })).toBeInTheDocument();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      const latestValue = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];

      expect(latestValue?.html).toContain('data-type="internal-reference"');
      expect(latestValue?.markdown).toContain("[[document:51|project-brief.pdf]]");
      expect(latestValue?.markdown).not.toContain("【【");
    });

    searchSpy.mockRestore();
  });

  it("marks unresolved internal references as broken when clicking them", async () => {
    const user = userEvent.setup();
    const onOpenReference = vi.fn(async () => false);
    const { container } = render(
      <RichEditor
        variant="bare"
        readOnly
        defaultHtml={`<p>${buildInternalReferenceHtml({
          refKind: "todo",
          refId: 18,
          label: "推进预算审批",
        })}</p>`}
        internalReferences={{
          context: { scope: "project", projectId: 1 },
          onOpenReference,
        }}
      />,
    );

    await user.click(screen.getByRole("link", { name: /Todo.*推进预算审批/u }));

    await waitFor(() => {
      expect(onOpenReference).toHaveBeenCalledWith({
        refKind: "todo",
        refId: 18,
        label: "推进预算审批",
      });
      expect(container.querySelector(".internal-reference-chip.is-broken")).toBeTruthy();
    });
  });
});

describe("RichEditor tag mentions", () => {
  it("opens the picker on # and inserts a tag mention chip token", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        tagMentions={{
          projectId: null,
          availableTags: [{ id: 11, label: "预算", colorKey: "amber", usageCount: 0, createdAt: "", updatedAt: "" }],
        }}
      />,
    );
    const surface = await getEditorSurface(container);

    await user.click(surface);
    await user.keyboard("#预");

    expect(await screen.findByRole("listbox", { name: "标签选择器" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /预算/u })).toBeInTheDocument();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      const latestValue = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
      expect(latestValue?.html).toContain('data-type="tag-mention"');
      expect(latestValue?.markdown).toContain("#[tag:11|预算|amber]");
    });
  });

  it("creates a new tag from # input and inserts it as a chip", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCreateTag = vi.fn(async (label: string) => ({
      id: 12,
      label,
      colorKey: "green" as const,
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    }));

    const { container } = render(
      <RichEditor
        variant="toolbar"
        onChange={onChange}
        tagMentions={{
          projectId: null,
          availableTags: [{ id: 11, label: "预算", colorKey: "amber", usageCount: 0, createdAt: "", updatedAt: "" }],
          onCreateTag,
        }}
      />,
    );
    const surface = await getEditorSurface(container);

    await user.click(surface);
    await user.keyboard("#新标签");

    expect(await screen.findByRole("listbox", { name: "标签选择器" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: /新建标签 “新标签”/u })).toBeInTheDocument();

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(onCreateTag).toHaveBeenCalledWith("新标签");
      const latestValue = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
      expect(latestValue?.html).toContain('data-type="tag-mention"');
      expect(latestValue?.markdown).toContain("#[tag:12|新标签|green]");
    });
  });
});

describe("RichEditor context menus", () => {
  it("shows the redesigned text menu for a non-collapsed text selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <RichEditor variant="bare" defaultHtml="<p>hello world</p>" onChange={onChange} />,
    );

    const paragraphText = await waitFor(() => {
      const textNode = container.querySelector(".ProseMirror p")?.firstChild;

      expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
      return textNode as Text;
    });

    fireEvent.focus(container.querySelector(".ProseMirror") as HTMLElement);
    selectTextContent(paragraphText, 0, 5);
    fireEvent.contextMenu(paragraphText.parentElement as HTMLElement, { clientX: 20, clientY: 20 });

    const menu = await screen.findByRole("menu", { name: "文本操作" });
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent ?? "");

    expect(labels).toEqual(["正文", "插入表格", "剪贴板"]);
    expect(within(menu).queryAllByRole("separator")).toHaveLength(2);
    expect(within(menu).getByRole("group", { name: "文本格式" })).toBeInTheDocument();

    await user.click(within(menu).getByRole("button", { name: "加粗" }));

    await waitFor(() => {
      expect(getLatestHtml(onChange)).toContain("<strong>hello</strong>");
    });
  });

  it("shows the text menu without the AI group for plain cursor context", async () => {
    const { container } = render(<RichEditor variant="bare" defaultHtml="<p>hello world</p>" />);

    const paragraph = await waitFor(() => {
      const nextParagraph = container.querySelector(".ProseMirror p");

      expect(nextParagraph).toBeTruthy();
      return nextParagraph as HTMLParagraphElement;
    });

    fireEvent.contextMenu(paragraph, { clientX: 20, clientY: 20 });

    const menu = await screen.findByRole("menu", { name: "文本操作" });
    expect(within(menu).getByRole("menuitem", { name: "正文" })).toBeInTheDocument();
    expect(within(menu).getByRole("group", { name: "文本格式" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "剪贴板" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "图片操作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "表格操作" })).not.toBeInTheDocument();
  });

  it("shows the active block selection in the featured submenu", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="bare" defaultHtml="<h2>hello world</h2>" />);

    const heading = await waitFor(() => {
      const nextHeading = container.querySelector(".ProseMirror h2");
      expect(nextHeading).toBeTruthy();
      return nextHeading as HTMLHeadingElement;
    });

    fireEvent.contextMenu(heading, { clientX: 20, clientY: 20 });

    const menu = await screen.findByRole("menu", { name: "文本操作" });
    const featured = within(menu).getByRole("menuitem", { name: "H2" });
    expect(featured.dataset.featured).toBe("true");

    await user.hover(featured);
    const submenu = await screen.findByRole("menu", { name: "H2 子菜单" });
    const selectedItem = within(submenu).getByRole("menuitem", { name: "H2" });
    expect(selectedItem.dataset.selected).toBe("true");
  });

  it("keeps selection actions ahead of the standard text menu", async () => {
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml="<p>hello world</p>"
        selectionActions={[
          {
            key: "custom-selection-action",
            label: "追加到项目默认笔记",
            icon: Copy,
            onSelect: vi.fn(),
          },
        ]}
      />,
    );

    const paragraphText = await waitFor(() => {
      const textNode = container.querySelector(".ProseMirror p")?.firstChild;
      expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
      return textNode as Text;
    });

    fireEvent.focus(container.querySelector(".ProseMirror") as HTMLElement);
    selectTextContent(paragraphText, 0, 5);
    fireEvent.contextMenu(paragraphText.parentElement as HTMLElement, { clientX: 20, clientY: 20 });

    const menu = await screen.findByRole("menu", { name: "选区操作" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent ?? "")).toEqual([
      "追加到项目默认笔记",
      "正文",
      "剪贴板",
    ]);
  });

  it("restores the remembered text selection when the browser clears it before right click", async () => {
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml="<p>hello world</p>"
        aiSettings={{
          profiles: [],
          bindings: [],
          hasUsableDefault: true,
          securityMode: "workspace_password_encrypted",
          aiSecretsUnlocked: true,
          execution: { maxConcurrency: 1 },
          featureSettings: {
            masterEnabled: true,
            capabilities: {
              assistant: true,
              summary: true,
              suggestion_generation: true,
              editor_rewrite: true,
            },
            features: {
              "summary.activity_summary": true,
              "summary.project_brief": true,
              "summary.daily_brief": true,
              "suggestion_generation.conclusion": true,
              "suggestion_generation.todo": true,
            },
          },
          editorRewriteActions: [
            {
              id: 1,
              label: "润色",
              prompt: "请润色",
              enabled: true,
              createdAt: "",
              updatedAt: "",
            },
          ],
        }}
      />,
    );

    const paragraphText = await waitFor(() => {
      const textNode = container.querySelector(".ProseMirror p")?.firstChild;
      expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
      return textNode as Text;
    });

    fireEvent.focus(container.querySelector(".ProseMirror") as HTMLElement);
    selectTextContent(paragraphText, 0, 5);
    clearBrowserSelection();
    fireEvent.contextMenu(paragraphText.parentElement as HTMLElement, {
      clientX: 20,
      clientY: 20,
    });

    const menu = await screen.findByRole("dialog", { name: "AI 编辑菜单" });
    expect(within(menu).getByRole("button", { name: "润色" })).toBeInTheDocument();
    expect(within(menu).getByPlaceholderText("使用 AI 编辑")).toBeInTheDocument();
  });

  it("shows configured AI rewrite actions in the dedicated AI menu even before the capability is ready", async () => {
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml="<p>hello world</p>"
        aiSettings={{
          profiles: [],
          bindings: [],
          hasUsableDefault: false,
          securityMode: "workspace_password_encrypted",
          aiSecretsUnlocked: false,
          execution: { maxConcurrency: 1 },
          featureSettings: {
            masterEnabled: true,
            capabilities: {
              assistant: true,
              summary: true,
              suggestion_generation: true,
              editor_rewrite: true,
            },
            features: {
              "summary.activity_summary": true,
              "summary.project_brief": true,
              "summary.daily_brief": true,
              "suggestion_generation.conclusion": true,
              "suggestion_generation.todo": true,
            },
          },
          editorRewriteActions: [
            {
              id: 2,
              label: "翻译",
              prompt: "请翻译成英文",
              enabled: true,
              createdAt: "",
              updatedAt: "",
            },
          ],
        }}
      />,
    );

    const paragraphText = await waitFor(() => {
      const textNode = container.querySelector(".ProseMirror p")?.firstChild;
      expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
      return textNode as Text;
    });

    fireEvent.focus(container.querySelector(".ProseMirror") as HTMLElement);
    selectTextContent(paragraphText, 0, 5);
    fireEvent.contextMenu(paragraphText.parentElement as HTMLElement, {
      clientX: 20,
      clientY: 20,
    });

    const menu = await screen.findByRole("dialog", { name: "AI 编辑菜单" });
    expect(within(menu).getByRole("button", { name: "翻译" })).toBeDisabled();
    expect(within(menu).getByPlaceholderText("使用 AI 编辑")).toBeDisabled();
    expect(within(menu).getByText("需先解锁 AI 配置")).toBeInTheDocument();
  });

  it("submits prompt overrides from the AI menu with Enter", async () => {
    const user = userEvent.setup();
    const ensureSyncSpy = vi.spyOn(aiJobs, "ensureAiJobSync").mockResolvedValue();
    const enqueueSpy = vi
      .spyOn(projectMindApi, "aiJobEnqueue")
      .mockResolvedValue({
        id: 11,
        kind: "editor_rewrite",
        targetKey: "editor-rewrite:test",
        status: "queued",
        queuedAt: "",
        startedAt: null,
        finishedAt: null,
        errorMessage: null,
        streamText: null,
        result: null,
      });
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml="<p>hello world</p>"
        aiSettings={{
          profiles: [],
          bindings: [],
          hasUsableDefault: true,
          securityMode: "workspace_password_encrypted",
          aiSecretsUnlocked: true,
          execution: { maxConcurrency: 1 },
          featureSettings: {
            masterEnabled: true,
            capabilities: {
              assistant: true,
              summary: true,
              suggestion_generation: true,
              editor_rewrite: true,
            },
            features: {
              "summary.activity_summary": true,
              "summary.project_brief": true,
              "summary.daily_brief": true,
              "suggestion_generation.conclusion": true,
              "suggestion_generation.todo": true,
            },
          },
          editorRewriteActions: [],
        }}
      />,
    );

    const paragraphText = await waitFor(() => {
      const textNode = container.querySelector(".ProseMirror p")?.firstChild;
      expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
      return textNode as Text;
    });

    fireEvent.focus(container.querySelector(".ProseMirror") as HTMLElement);
    selectTextContent(paragraphText, 0, 5);
    fireEvent.contextMenu(paragraphText.parentElement as HTMLElement, {
      clientX: 20,
      clientY: 20,
    });

    const menu = await screen.findByRole("dialog", { name: "AI 编辑菜单" });
    const promptInput = within(menu).getByPlaceholderText("使用 AI 编辑");
    await user.type(promptInput, "请翻译成英文");
    fireEvent.keyDown(promptInput, { key: "Enter" });

    await waitFor(() => {
      expect(enqueueSpy).toHaveBeenCalled();
    });

    expect(ensureSyncSpy).toHaveBeenCalled();
    const request = enqueueSpy.mock.calls[0]?.[0];
    expect(request.kind).toBe("editor_rewrite");
    if (request.kind !== "editor_rewrite") {
      throw new Error("expected an editor rewrite job");
    }
    expect(request.input.promptOverride).toBe("请翻译成英文");
    expect(request.input.actionId).toBeNull();

    enqueueSpy.mockRestore();
    ensureSyncSpy.mockRestore();
  });

  it("renders inline rewrite suggestions in the editor and accepts the streamed result", async () => {
    const user = userEvent.setup();
    const ensureSyncSpy = vi.spyOn(aiJobs, "ensureAiJobSync").mockResolvedValue();
    let targetKey = "";
    const enqueueSpy = vi
      .spyOn(projectMindApi, "aiJobEnqueue")
      .mockImplementation(async (input) => {
        targetKey = input.targetKey;
        return {
          id: 41,
          kind: "editor_rewrite",
          targetKey,
          status: "queued",
          queuedAt: "",
          startedAt: null,
          finishedAt: null,
          errorMessage: null,
          streamText: null,
          result: null,
        };
      });
    const onChange = vi.fn();
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml="<p>hello world</p>"
        onChange={onChange}
        aiSettings={{
          profiles: [],
          bindings: [],
          hasUsableDefault: true,
          securityMode: "workspace_password_encrypted",
          aiSecretsUnlocked: true,
          execution: { maxConcurrency: 1 },
          featureSettings: {
            masterEnabled: true,
            capabilities: {
              assistant: true,
              summary: true,
              suggestion_generation: true,
              editor_rewrite: true,
            },
            features: {
              "summary.activity_summary": true,
              "summary.project_brief": true,
              "summary.daily_brief": true,
              "suggestion_generation.conclusion": true,
              "suggestion_generation.todo": true,
            },
          },
          editorRewriteActions: [
            {
              id: 9,
              label: "润色",
              prompt: "请润色",
              enabled: true,
              createdAt: "",
              updatedAt: "",
            },
          ],
        }}
      />,
    );

    const paragraphText = await waitFor(() => {
      const textNode = container.querySelector(".ProseMirror p")?.firstChild;
      expect(textNode?.nodeType).toBe(Node.TEXT_NODE);
      return textNode as Text;
    });

    fireEvent.focus(container.querySelector(".ProseMirror") as HTMLElement);
    selectTextContent(paragraphText, 0, 5);
    fireEvent.contextMenu(paragraphText.parentElement as HTMLElement, {
      clientX: 20,
      clientY: 20,
    });

    const menu = await screen.findByRole("dialog", { name: "AI 编辑菜单" });
    await user.click(within(menu).getByRole("button", { name: "润色" }));

    await waitFor(() => {
      expect(targetKey).toContain("editor-rewrite:");
    });

    useAiJobStore.getState().upsertJob({
      id: 41,
      kind: "editor_rewrite",
      targetKey,
      status: "running",
      queuedAt: "",
      startedAt: "",
      finishedAt: null,
      errorMessage: null,
      streamText: "hello universe",
      result: null,
    });

    await waitFor(() => {
      expect(screen.getByText("AI 正在润色…")).toBeInTheDocument();
      expect(container.querySelector(".rich-editor__rewrite-origin-block")).toBeTruthy();
    });

    useAiJobStore.getState().upsertJob({
      id: 41,
      kind: "editor_rewrite",
      targetKey,
      status: "succeeded",
      queuedAt: "",
      startedAt: "",
      finishedAt: "",
      errorMessage: null,
      streamText: "hello universe",
      result: {
        kind: "editor_rewrite",
        rewrite: {
          actionId: 9,
          rewrittenMarkdown: "hello universe",
          resolvedModel: "mock-model",
        },
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "接受 AI 建议" })).toBeEnabled();
    });
    const acceptButton = screen.getByRole("button", { name: "接受 AI 建议" });
    await user.click(acceptButton);

    await waitFor(() => {
      expect(container.querySelector(".rich-editor__rewrite-origin-block")).toBeNull();
      expect(container.querySelector(".ProseMirror")?.textContent).toContain("hello universe");
    });

    enqueueSpy.mockRestore();
    ensureSyncSpy.mockRestore();
  });

  it("shows the table menu inside a table and applies row insertion", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="toolbar" />);

    await user.click(await screen.findByLabelText("表格"));
    await user.click(screen.getByLabelText("插入 2 行 2 列表格"));

    const cell = await waitFor(() => {
      const nextCell = container.querySelector("table td, table th");

      expect(nextCell).toBeTruthy();
      return nextCell as HTMLElement;
    });

    fireEvent.contextMenu(cell, { clientX: 44, clientY: 44 });

    const tableMenu = await screen.findByRole("menu", { name: "表格操作" });
    expect(within(tableMenu).getByRole("menuitem", { name: /合并单元格/i })).toBeDisabled();

    await user.click(within(tableMenu).getByRole("menuitem", { name: /下方插入行/i }));

    await waitFor(() => {
      expect(container.querySelectorAll("table tr")).toHaveLength(3);
    });
  });

  it("prefers the text menu over the table menu when text is selected inside a cell", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="toolbar" />);

    await user.click(await screen.findByLabelText("表格"));
    await user.click(screen.getByLabelText("插入 1 行 1 列表格"));

    const cellParagraph = await waitFor(() => {
      const nextParagraph = container.querySelector("table td p, table th p");

      expect(nextParagraph).toBeTruthy();
      return nextParagraph as HTMLParagraphElement;
    });

    await user.click(cellParagraph);
    await user.type(cellParagraph, "Cell text");

    const textNode = await waitFor(() => {
      const nextTextNode = cellParagraph.firstChild;

      expect(nextTextNode?.nodeType).toBe(Node.TEXT_NODE);
      return nextTextNode as Text;
    });

    selectTextContent(textNode, 0, 4);
    fireEvent.contextMenu(cellParagraph, { clientX: 48, clientY: 48 });

    expect(await screen.findByRole("menu", { name: "文本操作" })).toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "表格操作" })).not.toBeInTheDocument();
  });

  it("copies ordered lists as readable plain text when execCommand falls back", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    const execCommand = document.execCommand as unknown as ReturnType<typeof vi.fn>;
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml="<ol><li><p>第一项</p></li><li><p>第二项</p></li></ol>"
      />,
    );

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
      },
    });

    const textNodes = await waitFor(() => {
      const nextNodes = Array.from(container.querySelectorAll(".ProseMirror li p"))
        .map((element) => element.firstChild)
        .filter((node): node is Text => node?.nodeType === Node.TEXT_NODE);

      expect(nextNodes).toHaveLength(2);
      return nextNodes;
    });

    fireEvent.focus(container.querySelector(".ProseMirror") as HTMLElement);
    selectTextRange(textNodes[0], 0, textNodes[1], textNodes[1].textContent?.length ?? 0);
    fireEvent.contextMenu(textNodes[0].parentElement as HTMLElement, { clientX: 24, clientY: 24 });

    execCommand.mockReturnValueOnce(false);
    const menu = await screen.findByRole("menu", { name: "文本操作" });
    await user.hover(within(menu).getByRole("menuitem", { name: "剪贴板" }));
    await user.click(await screen.findByRole("menuitem", { name: /复制/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(["1. 第一项", "2. 第二项"].join("\n"));
    });
  });

  it("copies mixed text and images as html with inlined image data", async () => {
    const user = userEvent.setup();
    const setData = vi.fn();
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml={
          '<p>前文</p><p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="截图" /></p><p>后文</p>'
        }
      />,
    );

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    fireEvent.focus(surface);
    fireEvent.contextMenu(surface, { clientX: 24, clientY: 24 });
    const menu = await screen.findByRole("menu", { name: "文本操作" });
    await user.hover(within(menu).getByRole("menuitem", { name: "剪贴板" }));
    await user.click(await screen.findByRole("menuitem", { name: /全选/i }));

    fireEvent.copy(surface, {
      clipboardData: {
        setData,
      },
    });

    expect(setData).toHaveBeenCalledWith("text/plain", expect.stringContaining("前文"));
    expect(setData).toHaveBeenCalledWith("text/plain", expect.stringContaining("后文"));
    expect(setData).toHaveBeenCalledWith(
      "text/html",
      expect.stringContaining('src="data:image/png;base64,AAAA"'),
    );
    expect(setData).toHaveBeenCalledWith(
      "text/html",
      expect.stringContaining('alt="截图"'),
    );
  });

  it("upgrades native copy events to original image bytes when async clipboard is available", async () => {
    const user = userEvent.setup();
    const setData = vi.fn();
    const write = vi.fn(async (items: Array<{ data: Record<string, Blob> }>) => items);
    const clipboardItemSpy = vi.fn();
    class ClipboardItemMock {
      data: Record<string, Blob>;

      constructor(data: Record<string, Blob>) {
        this.data = data;
        clipboardItemSpy(data);
      }
    }
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml={
          '<p>前文</p><p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="截图" /></p><p>后文</p>'
        }
      />,
    );

    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: ClipboardItemMock,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write,
      },
    });

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    fireEvent.focus(surface);
    fireEvent.contextMenu(surface, { clientX: 24, clientY: 24 });
    const menu = await screen.findByRole("menu", { name: "文本操作" });
    await user.hover(within(menu).getByRole("menuitem", { name: "剪贴板" }));
    await user.click(await screen.findByRole("menuitem", { name: /全选/i }));

    fireEvent.copy(surface, {
      clipboardData: {
        setData,
      },
    });

    expect(setData).toHaveBeenCalledWith(
      "text/html",
      expect.stringContaining('src="data:image/png;base64,AAAA"'),
    );

    await waitFor(() => {
      expect(desktopApi.readFileAsDataUrl).toHaveBeenCalledWith(
        "/tmp/managed/clip.png",
        "image/png",
      );
      expect(write).toHaveBeenCalledTimes(1);
    });

    const htmlBlob = clipboardItemSpy.mock.calls[0]?.[0]?.["text/html"] as Blob;
    const html = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => reject(reader.error ?? new Error("读取剪贴板 html 失败"));
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsText(htmlBlob);
    });

    expect(html).toContain(`src="data:image/png;base64,${btoa("/tmp/managed/clip.png")}"`);
  });

  it("prefers original file bytes when copy falls back to async clipboard writes", async () => {
    const user = userEvent.setup();
    const execCommand = document.execCommand as unknown as ReturnType<typeof vi.fn>;
    const write = vi.fn(async (items: Array<{ data: Record<string, Blob> }>) => items);
    const clipboardItemSpy = vi.fn();
    class ClipboardItemMock {
      data: Record<string, Blob>;

      constructor(data: Record<string, Blob>) {
        this.data = data;
        clipboardItemSpy(data);
      }
    }
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml={
          '<p>前文</p><p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="截图" /></p><p>后文</p>'
        }
      />,
    );

    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: ClipboardItemMock,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write,
      },
    });

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    fireEvent.focus(surface);
    fireEvent.contextMenu(surface, { clientX: 24, clientY: 24 });
    const menu = await screen.findByRole("menu", { name: "文本操作" });
    await user.hover(within(menu).getByRole("menuitem", { name: "剪贴板" }));
    await user.click(await screen.findByRole("menuitem", { name: /全选/i }));

    execCommand.mockReturnValueOnce(false);
    fireEvent.contextMenu(surface, { clientX: 24, clientY: 24 });
    const reopenedMenu = await screen.findByRole("menu", { name: "文本操作" });
    await user.click(within(reopenedMenu).getByRole("menuitem", { name: "剪贴板" }));
    const clipboardSubmenu = await screen.findByRole("menu", { name: "剪贴板 子菜单" });
    await user.click(within(clipboardSubmenu).getByRole("menuitem", { name: /^复制/ }));

    await waitFor(() => {
      expect(desktopApi.readFileAsDataUrl).toHaveBeenCalledWith(
        "/tmp/managed/clip.png",
        "image/png",
      );
      expect(write).toHaveBeenCalledTimes(1);
    });

    const htmlBlob = clipboardItemSpy.mock.calls[0]?.[0]?.["text/html"] as Blob;
    const html = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => reject(reader.error ?? new Error("读取剪贴板 html 失败"));
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsText(htmlBlob);
    });

    expect(html).toContain(`src="data:image/png;base64,${btoa("/tmp/managed/clip.png")}"`);
  });

  it("lazy-mounts image sources until they enter the viewport", async () => {
    defaultIntersectionState = false;
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml='<p><img src="asset:///tmp/managed/lazy.png" data-path="/tmp/managed/lazy.png" data-mime-type="image/png" alt="懒加载图片" /></p>'
      />,
    );

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img.rich-editor__image");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    expect(image.getAttribute("src")).toContain("data:image/gif;base64");
    expect(image.dataset.lazyMounted).toBe("false");

    triggerIntersection(true);

    await waitFor(() => {
      expect(image.getAttribute("src")).toBe(
        "asset:///tmp/managed/lazy.png.960.thumb.jpg",
      );
      expect(image.dataset.lazyMounted).toBe("true");
    });
  });

  it("keeps the real image source mounted after it has entered the viewport", async () => {
    defaultIntersectionState = false;
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml='<p><img src="asset:///tmp/managed/lazy-stable.png" data-path="/tmp/managed/lazy-stable.png" data-mime-type="image/png" alt="稳定图片" /></p>'
      />,
    );

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img.rich-editor__image");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    expect(image.getAttribute("src")).toContain("data:image/gif;base64");

    triggerIntersection(true);

    await waitFor(() => {
      expect(image.getAttribute("src")).toBe(
        "asset:///tmp/managed/lazy-stable.png.960.thumb.jpg",
      );
      expect(image.dataset.lazyMounted).toBe("true");
    });

    triggerIntersection(false);

    await waitFor(() => {
      expect(image.getAttribute("src")).toBe(
        "asset:///tmp/managed/lazy-stable.png.960.thumb.jpg",
      );
      expect(image.dataset.lazyMounted).toBe("true");
    });
  });

  it("captures tab inside list items so focus stays in the editor", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <RichEditor
        variant="bare"
        defaultHtml="<ul><li><p>第一项</p></li><li><p>第二项</p></li></ul>"
      />,
    );

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    const secondParagraph = await waitFor(() => {
      const nextParagraph = container.querySelectorAll(".ProseMirror li p")[1];

      expect(nextParagraph).toBeTruthy();
      return nextParagraph as HTMLParagraphElement;
    });

    await user.click(secondParagraph);
    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });

    surface.dispatchEvent(tabEvent);

    expect(tabEvent.defaultPrevented).toBe(true);
    expect(surface).toHaveFocus();
  });

  it("does not let a stale controlled html echo overwrite newer typing", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container, rerender } = render(
      <RichEditor variant="bare" html="<p></p>" onChange={onChange} />,
    );

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    await user.click(surface);
    await user.type(surface, "a");

    const firstSnapshot = await waitFor(() => {
      const snapshot = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];

      expect(snapshot?.html).toBe("<p>a</p>");
      return snapshot;
    });

    await user.type(surface, "b");
    rerender(<RichEditor variant="bare" html={firstSnapshot.html} onChange={onChange} />);

    await waitFor(() => {
      expect(container.querySelector(".ProseMirror")?.textContent).toContain("ab");
    });
  });
});

describe("RichEditor focus and blur persistence", () => {
  it("focuses the editor surface when autoFocus is enabled", async () => {
    const { container } = render(<RichEditor variant="bare" autoFocus />);

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    await waitFor(() => {
      expect(surface).toHaveFocus();
    });
  });

  it("persists on blur and notifies the caller after a successful save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (value: unknown) => value);
    const onBlurPersisted = vi.fn();
    const { container } = render(
      <RichEditor variant="bare" autoFocus autosave onSave={onSave} onBlurPersisted={onBlurPersisted} />,
    );

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    await user.type(surface, "Blur saves this");
    fireEvent.blur(surface);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onBlurPersisted).toHaveBeenCalledTimes(1);
    });
  });

  it("does not notify blur persistence when saving fails", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new Error("save failed");
    });
    const onBlurPersisted = vi.fn();
    const { container } = render(
      <RichEditor variant="bare" autoFocus autosave onSave={onSave} onBlurPersisted={onBlurPersisted} />,
    );

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    await user.type(surface, "Blur fails");
    fireEvent.blur(surface);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onBlurPersisted).not.toHaveBeenCalled();
  });

  it("persists on window blur without notifying blur persistence", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (value: unknown) => value);
    const onBlurPersisted = vi.fn();
    const { container } = render(
      <RichEditor
        variant="bare"
        autoFocus
        autosave={{ onChange: false, onBlur: true, onWindowBlur: true }}
        onSave={onSave}
        onBlurPersisted={onBlurPersisted}
      />,
    );

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    await user.type(surface, "Window blur saves this");
    fireEvent(window, new Event("blur"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(onBlurPersisted).not.toHaveBeenCalled();
  });

  it("skips window-blur persistence while an image picker is in flight", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (value: unknown) => value);
    const pickFileSpy = vi.spyOn(desktopApi, "pickFile").mockImplementation(
      () => new Promise<string | null>(() => undefined),
    );
    const { container } = render(
      <RichEditor
        variant="toolbar"
        autoFocus
        autosave={{ onChange: false, onBlur: true, onWindowBlur: true }}
        onSave={onSave}
        assetHandlers={{
          insertImage: async () => ({
            kind: "image",
            title: "clip.png",
            path: "/tmp/managed/clip.png",
            mimeType: "image/png",
          }),
        }}
      />,
    );

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    await user.type(surface, "Window blur should not save while picking");
    await user.click(await screen.findByLabelText("图片"));
    fireEvent(window, new Event("blur"));

    await waitFor(() => {
      expect(pickFileSpy).toHaveBeenCalledTimes(1);
    });
    expect(onSave).not.toHaveBeenCalled();

    pickFileSpy.mockRestore();
  });

  it("flushes unsaved edits on pagehide for lock/sleep/quit lifecycles", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async (value: unknown) => value);
    const { container } = render(
      <RichEditor
        variant="bare"
        autoFocus
        autosave={{ onChange: false, onBlur: true, onVisibilityChange: true }}
        onSave={onSave}
      />,
    );

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    await user.type(surface, "Pagehide saves this");
    fireEvent(window, new Event("pagehide"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  it("runs the mod-enter callback when pressing Ctrl/Cmd + Enter", async () => {
    const user = userEvent.setup();
    const onModEnter = vi.fn();
    const { container } = render(<RichEditor variant="bare" autoFocus onModEnter={onModEnter} />);

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".ProseMirror");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    await user.click(surface);
    fireEvent.keyDown(surface, {
      key: "Enter",
      metaKey: true,
    });

    expect(onModEnter).toHaveBeenCalledTimes(1);
  });
});
