import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { desktopApi } from "../../services/desktopApi";
import { RichEditor } from "./RichEditor";

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

function selectTextContent(node: Text, start: number, end: number) {
  const selection = window.getSelection();
  const range = document.createRange();

  range.setStart(node, start);
  range.setEnd(node, end);
  selection?.removeAllRanges();
  selection?.addRange(range);
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
    expect(onChange).toHaveBeenCalled();
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

  it("shows a compact table action for focused bare editors", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="bare" />);

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".rich-editor__surface");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    fireEvent.focus(surface);
    await user.click(await screen.findByRole("button", { name: "插入表格" }));
    await user.click(screen.getByLabelText("插入 1 行 2 列表格"));

    await waitFor(() => {
      expect(container.querySelectorAll("table tr")).toHaveLength(1);
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

      expect(html).toContain('style="width: 312px;"');
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
    expect(getLatestHtml(onChange)).toContain("<table");
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

  it("embeds inserted managed images as data urls while keeping the file path", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const pickFileSpy = vi.spyOn(desktopApi, "pickFile").mockResolvedValue("/tmp/clip.png");
    const readFileSpy = vi.spyOn(desktopApi, "readFileAsDataUrl");
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

    expect(readFileSpy).toHaveBeenCalledWith("/tmp/managed/clip.png", "image/png");
    expect(image.getAttribute("src")).toBe(`data:image/png;base64,${btoa("/tmp/managed/clip.png")}`);

    await waitFor(() => {
      const html = getLatestHtml(onChange);

      expect(html).toContain('src="data:image/png;base64,');
      expect(html).toContain('data-path="/tmp/managed/clip.png"');
    });

    pickFileSpy.mockRestore();
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
      expect(savedHtml).toContain('src="data:image/png;base64,');
      expect(savedHtml).toContain('data-path="/tmp/managed/clip.png"');
    });

    unmount();
    const reopened = render(<RichEditor variant="toolbar" defaultHtml={savedHtml} />);

    const image = await waitFor(() => {
      const nextImage = reopened.container.querySelector("img");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    expect(image.getAttribute("src")).toContain("data:image/png;base64,");
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
      expect(savedHtml).toContain('src="data:image/png;base64,AAAA"');
      expect(savedHtml).toContain('data-path="/tmp/managed/clipboard.png"');
    });

    unmount();
    const reopened = render(<RichEditor variant="toolbar" defaultHtml={savedHtml} />);

    const image = await waitFor(() => {
      const nextImage = reopened.container.querySelector("img");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    expect(image.getAttribute("src")).toContain("data:image/png;base64,");
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

    expect(image.getAttribute("src")).toBe("asset:///tmp/fixed.png");
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
    expect(getLatestHtml(onChange)).toContain('data-path="/tmp/managed/html-paste.png"');
  });
});

describe("RichEditor context menus", () => {
  it("shows the format-first text menu for a non-collapsed text selection", async () => {
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

    expect(labels).toEqual([
      expect.stringMatching(/^加粗/),
      expect.stringMatching(/^斜体/),
      expect.stringMatching(/^着重色/),
      expect.stringMatching(/^正文/),
      expect.stringMatching(/^H1/),
      expect.stringMatching(/^H2/),
      expect.stringMatching(/^H3/),
      expect.stringMatching(/^无序列表/),
      expect.stringMatching(/^有序列表/),
      expect.stringMatching(/^Todo List/),
      expect.stringMatching(/^引用/),
      expect.stringMatching(/^代码段/),
      expect.stringMatching(/^复制/),
      expect.stringMatching(/^剪切/),
      expect.stringMatching(/^全选/),
    ]);
    expect(within(menu).getAllByRole("separator")).toHaveLength(3);

    await user.click(within(menu).getByRole("menuitem", { name: /加粗/i }));

    await waitFor(() => {
      expect(getLatestHtml(onChange)).toContain("<strong>hello</strong>");
    });
  });

  it("keeps the native menu for plain cursor context", async () => {
    const { container } = render(<RichEditor variant="bare" defaultHtml="<p>hello world</p>" />);

    const paragraph = await waitFor(() => {
      const nextParagraph = container.querySelector(".ProseMirror p");

      expect(nextParagraph).toBeTruthy();
      return nextParagraph as HTMLParagraphElement;
    });

    fireEvent.contextMenu(paragraph, { clientX: 20, clientY: 20 });

    expect(screen.queryByRole("menu", { name: "文本操作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "图片操作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "表格操作" })).not.toBeInTheDocument();
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
