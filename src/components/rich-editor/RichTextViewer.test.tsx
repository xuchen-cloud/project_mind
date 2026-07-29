import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { desktopApi } from "../../services/desktopApi";
import { clearManagedImageThumbnailCacheForTests } from "./imageThumbnails";
import { clearRichTextViewerCacheForTests, RichTextViewer } from "./RichTextViewer";

beforeEach(() => {
  clearManagedImageThumbnailCacheForTests();
  clearRichTextViewerCacheForTests();
  vi.restoreAllMocks();
  vi.spyOn(desktopApi, "toFileUrl").mockImplementation((path) => `asset://${path}`);
  vi.spyOn(desktopApi, "readFileAsDataUrl").mockImplementation(async (path, mimeType) => {
    const resolvedMimeType = mimeType || "image/png";
    return `data:${resolvedMimeType};base64,${btoa(path)}`;
  });
  vi.spyOn(desktopApi, "generateImageThumbnail").mockImplementation(async (path, maxEdge) => {
    return `${path}.${maxEdge}.thumb.jpg`;
  });
});

describe("RichTextViewer", () => {
  it("defers managed image html repair until the viewer enters the viewport", async () => {
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    const intersectionCallbacks: IntersectionObserverCallback[] = [];

    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: class IntersectionObserver {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallbacks.push(callback);
        }

        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords = () => [];
        root = null;
        rootMargin = "0px";
        thresholds = [];
      },
    });

    try {
      const { container } = render(
        <RichTextViewer
          deferUntilVisible
          html='<p><img src="/tmp/stale.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>'
        />,
      );

      expect(container.querySelector("img")).toBeNull();
      expect(desktopApi.toFileUrl).not.toHaveBeenCalled();

      intersectionCallbacks[0]?.(
        [
          {
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );

      await waitFor(() => {
        expect(container.querySelector("img")).toBeTruthy();
      });
      await waitFor(() => {
        expect(intersectionCallbacks.length).toBeGreaterThanOrEqual(2);
      });

      intersectionCallbacks[1]?.(
        [
          {
            isIntersecting: true,
            intersectionRatio: 1,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );

      await waitFor(() => {
        expect(container.querySelector("img")?.getAttribute("src")).toBe(
          "asset:///tmp/managed/clip.png.960.thumb.jpg",
        );
      });
      expect(desktopApi.toFileUrl).toHaveBeenCalledWith("/tmp/managed/clip.png");
      expect(desktopApi.generateImageThumbnail).toHaveBeenCalledWith(
        "/tmp/managed/clip.png",
        960,
      );
    } finally {
      Object.defineProperty(globalThis, "IntersectionObserver", {
        configurable: true,
        value: originalIntersectionObserver,
      });
    }
  });

  it("keeps managed images thumbnail-backed by default", async () => {
    const { container } = render(
      <RichTextViewer
        html='<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>'
      />,
    );

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "asset:///tmp/managed/clip.png.960.thumb.jpg",
      );
    });
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("decoding")).toBe("async");
    expect(desktopApi.generateImageThumbnail).toHaveBeenCalledWith(
      "/tmp/managed/clip.png",
      960,
    );
    expect(desktopApi.readFileAsDataUrl).not.toHaveBeenCalled();
  });

  it("keeps hydrated managed images visible across rerenders", async () => {
    const sourceHtml =
      '<p><img src="asset:///tmp/managed/stable.png" data-path="/tmp/managed/stable.png" data-mime-type="image/png" alt="stable.png" /></p>';
    const { container, rerender } = render(
      <RichTextViewer html={sourceHtml} eagerManagedImages />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "asset:///tmp/managed/stable.png.960.thumb.jpg",
      );
    });
    const image = container.querySelector("img") as HTMLImageElement;

    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 960,
    });
    image.dispatchEvent(new Event("load"));

    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("data-thumbnail-loaded")).toBe("true");
    });

    rerender(<RichTextViewer html={sourceHtml} eagerManagedImages />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "asset:///tmp/managed/stable.png.960.thumb.jpg",
    );
  });

  it("reuses hydrated managed images after remounting the same viewer html", async () => {
    const sourceHtml =
      '<p><img src="asset:///tmp/managed/resident.png" data-path="/tmp/managed/resident.png" data-mime-type="image/png" alt="resident.png" /></p>';
    const firstRender = render(<RichTextViewer html={sourceHtml} eagerManagedImages />);

    await waitFor(() => {
      expect(firstRender.container.querySelector("img")?.getAttribute("src")).toBe(
        "asset:///tmp/managed/resident.png.960.thumb.jpg",
      );
    });
    const loadedImage = firstRender.container.querySelector("img") as HTMLImageElement;

    Object.defineProperty(loadedImage, "naturalWidth", {
      configurable: true,
      value: 960,
    });
    loadedImage.dispatchEvent(new Event("load"));

    await waitFor(() => {
      expect(
        firstRender.container.querySelector("img")?.getAttribute("data-thumbnail-loaded"),
      ).toBe("true");
    });

    firstRender.unmount();
    clearManagedImageThumbnailCacheForTests();

    const secondRender = render(<RichTextViewer html={sourceHtml} eagerManagedImages />);

    expect(secondRender.container.querySelector("img")?.getAttribute("src")).toBe(
      "asset:///tmp/managed/resident.png.960.thumb.jpg",
    );
    expect(desktopApi.generateImageThumbnail).toHaveBeenCalledTimes(1);
  });

  it("hydrates visible managed images even when the image intersection observer has not fired", async () => {
    const originalIntersectionObserver = globalThis.IntersectionObserver;
    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;

    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: class IntersectionObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords = () => [];
        root = null;
        rootMargin = "0px";
        thresholds = [];
      },
    });
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: (handle: number) => window.clearTimeout(handle),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 100,
      top: 100,
      right: 300,
      bottom: 300,
      left: 0,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const { container } = render(
        <RichTextViewer
          html='<p><img src="asset:///tmp/managed/visible.png" data-path="/tmp/managed/visible.png" data-mime-type="image/png" width="300" alt="visible.png" /></p>'
        />,
      );

      const image = await waitFor(() => {
        const nextImage = container.querySelector("img");

        expect(nextImage).toBeTruthy();
        return nextImage as HTMLImageElement;
      });

      await waitFor(() => {
        expect(image.getAttribute("src")).toBe(
          "asset:///tmp/managed/visible.png.960.thumb.jpg",
        );
      });
      expect(desktopApi.generateImageThumbnail).toHaveBeenCalledWith(
        "/tmp/managed/visible.png",
        960,
      );
    } finally {
      Object.defineProperty(globalThis, "IntersectionObserver", {
        configurable: true,
        value: originalIntersectionObserver,
      });
      Object.defineProperty(window, "requestAnimationFrame", {
        configurable: true,
        value: originalRequestAnimationFrame,
      });
      Object.defineProperty(window, "cancelAnimationFrame", {
        configurable: true,
        value: originalCancelAnimationFrame,
      });
    }
  });

  it("eagerly hydrates managed images without waiting for viewport detection", async () => {
    const originalIntersectionObserver = globalThis.IntersectionObserver;

    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: class IntersectionObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords = () => [];
        root = null;
        rootMargin = "0px";
        thresholds = [];
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    } as DOMRect);

    try {
      const { container } = render(
        <RichTextViewer
          eagerManagedImages
          html='<p><img src="asset:///tmp/managed/eager.png" data-path="/tmp/managed/eager.png" data-mime-type="image/png" alt="eager.png" /></p>'
        />,
      );

      const image = await waitFor(() => {
        const nextImage = container.querySelector("img");

        expect(nextImage).toBeTruthy();
        return nextImage as HTMLImageElement;
      });

      await waitFor(() => {
        expect(image.getAttribute("src")).toBe(
          "asset:///tmp/managed/eager.png.960.thumb.jpg",
        );
      });
      expect(desktopApi.generateImageThumbnail).toHaveBeenCalledWith(
        "/tmp/managed/eager.png",
        960,
      );
    } finally {
      Object.defineProperty(globalThis, "IntersectionObserver", {
        configurable: true,
        value: originalIntersectionObserver,
      });
    }
  });

  it("does not hydrate managed images while inactive", async () => {
    const { container, rerender } = render(
      <RichTextViewer
        active={false}
        html='<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>'
      />,
    );

    await waitFor(() => {
      const nextImage = container.querySelector("img");

      expect(nextImage).toBeTruthy();
    });

    expect(desktopApi.generateImageThumbnail).not.toHaveBeenCalled();

    rerender(
      <RichTextViewer
        active
        html='<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>'
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "asset:///tmp/managed/clip.png.960.thumb.jpg",
      );
    });
    expect(desktopApi.generateImageThumbnail).toHaveBeenCalledTimes(1);
  });

  it("falls back to a data url when a managed image fails to load", async () => {
    vi.mocked(desktopApi.generateImageThumbnail).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const { container } = render(
      <RichTextViewer
        html='<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip.png" /></p>'
      />,
    );

    const image = await waitFor(() => {
      const nextImage = container.querySelector("img");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    image.dispatchEvent(new Event("error"));

    await waitFor(() => {
      expect(desktopApi.readFileAsDataUrl).toHaveBeenCalledWith(
        "/tmp/managed/clip.png",
        "image/png",
      );
      expect(image.getAttribute("src")).toBe(
        `data:image/png;base64,${btoa("/tmp/managed/clip.png")}`,
      );
    });
  });

  it("deduplicates concurrent fallback reads for the same managed image", async () => {
    const sourceHtml =
      '<p><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip one" /><img src="asset:///tmp/managed/clip.png" data-path="/tmp/managed/clip.png" data-mime-type="image/png" alt="clip two" /></p>';
    let resolveRead: ((value: string) => void) | null = null;
    vi.mocked(desktopApi.generateImageThumbnail).mockImplementation(
      () => new Promise(() => {}),
    );
    vi.mocked(desktopApi.readFileAsDataUrl).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const { container } = render(
      <RichTextViewer html={sourceHtml} />,
    );

    const images = await waitFor(() => {
      const nextImages = Array.from(container.querySelectorAll("img"));

      expect(nextImages).toHaveLength(2);
      return nextImages as HTMLImageElement[];
    });

    images[0]?.dispatchEvent(new Event("error"));
    images[1]?.dispatchEvent(new Event("error"));

    expect(desktopApi.readFileAsDataUrl).toHaveBeenCalledTimes(1);

    resolveRead?.(`data:image/png;base64,${btoa("/tmp/managed/clip.png")}`);

    await waitFor(() => {
      expect(images[0]?.getAttribute("src")).toBe(
        `data:image/png;base64,${btoa("/tmp/managed/clip.png")}`,
      );
      expect(images[1]?.getAttribute("src")).toBe(
        `data:image/png;base64,${btoa("/tmp/managed/clip.png")}`,
      );
    });
  });
});
