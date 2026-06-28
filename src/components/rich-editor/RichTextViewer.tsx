import { useEffect, useMemo, useRef, useState } from "react";

import { repairRichTextAssetHtml } from "../../lib/richTextAssets";
import { desktopApi } from "../../services/desktopApi";
import {
  resolveManagedImageDisplaySrc,
  TRANSPARENT_IMAGE_DATA_URL,
} from "./imageThumbnails";

const viewerImagePendingCache = new Map<string, Promise<string>>();
const VIEWER_IMAGE_MIN_HEIGHT = 60;
const VIEWER_IMAGE_MAX_PLACEHOLDER_HEIGHT = 420;
const VIEWER_IMAGE_DEFAULT_ASPECT_RATIO = 3 / 2;
const VIEWER_IMAGE_ROOT_MARGIN_PX = 360;
const VIEWER_HTML_CACHE_TTL_MS = 30 * 60 * 1000;
const VIEWER_HTML_CACHE_MAX_ENTRIES = 120;

interface ViewerHtmlCacheEntry {
  html: string;
  lastUsedAt: number;
}

const viewerHtmlCache = new Map<string, ViewerHtmlCacheEntry>();

interface RichTextViewerProps {
  html?: string | null;
  className?: string;
  deferUntilVisible?: boolean;
  active?: boolean;
  eagerManagedImages?: boolean;
}

export function RichTextViewer({
  html,
  className = "rich-editor__surface ProseMirror",
  deferUntilVisible = false,
  active = true,
  eagerManagedImages = false,
}: RichTextViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rawHtml = html?.trim() ?? "";
  const [isVisible, setIsVisible] = useState(!deferUntilVisible);
  const renderableHtml = useMemo(() => {
    if (deferUntilVisible && !isVisible) {
      return "";
    }

    return repairRichTextAssetHtml(rawHtml);
  }, [deferUntilVisible, isVisible, rawHtml]);
  const [viewerHtml, setViewerHtml] = useState(() =>
    getViewerHtmlForRender(deferUntilVisible ? "" : repairRichTextAssetHtml(rawHtml)),
  );
  const placeholderMinHeight = useMemo(() => {
    if (!deferUntilVisible || isVisible || !rawHtml) {
      return undefined;
    }

    return /<img\b/i.test(rawHtml) ? 180 : 72;
  }, [deferUntilVisible, isVisible, rawHtml]);

  useEffect(() => {
    if (!active) {
      return;
    }

    if (!deferUntilVisible) {
      setIsVisible(true);
      return;
    }

    if (isVisible) {
      return;
    }

    const container = containerRef.current;

    if (!container || typeof IntersectionObserver === "undefined") {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];

        if (!entry || (!entry.isIntersecting && entry.intersectionRatio <= 0)) {
          return;
        }

        setIsVisible(true);
        observer.disconnect();
      },
      {
        root: null,
        rootMargin: "1200px 0px",
        threshold: 0.01,
      },
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, [active, deferUntilVisible, isVisible]);

  useEffect(() => {
    setViewerHtml(getViewerHtmlForRender(renderableHtml));
  }, [renderableHtml]);

  useEffect(() => {
    if (!active || !isVisible) {
      return;
    }

    const container = containerRef.current;

    if (!container) {
      return;
    }

    const cleanups: Array<() => void> = [];
    const persistViewerImageSrc = (path: string, displaySrc: string) => {
      setViewerHtml((current) => {
        const next = replaceViewerImageDisplaySrc(current, path, displaySrc);

        if (next !== current) {
          cacheViewerHtml(renderableHtml, next);
        }

        return next;
      });
    };

    container.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
      image.decoding = "async";
      image.loading = "lazy";
      image.style.maxWidth = "100%";
      image.style.height = "auto";
      applyViewerImagePlaceholderSizing(image);

      const handleError = () => {
        void recoverManagedViewerImageSource(image, (path, displaySrc) => {
          persistViewerImageSrc(path, displaySrc);
        });
      };
      const handleLoad = () => {
        const path = image.getAttribute("data-path")?.trim() ?? "";
        const displaySrc = image.getAttribute("src")?.trim() ?? "";

        if (
          !path ||
          !displaySrc ||
          displaySrc === TRANSPARENT_IMAGE_DATA_URL ||
          image.naturalWidth <= 0
        ) {
          return;
        }

        image.dataset.thumbnailLoaded = "true";
        image.style.minHeight = "";
        image.style.aspectRatio = "";
        persistViewerImageSrc(path, displaySrc);
      };
      const loadImage = () => {
        void hydrateManagedViewerImage(image);
      };

      image.addEventListener("error", handleError);
      image.addEventListener("load", handleLoad);

      const observer = createViewerImageObserver(image, loadImage);
      const frame = scheduleViewerImageVisibilityCheck(image, loadImage);

      if (eagerManagedImages && image.getAttribute("data-path")) {
        loadImage();
      }

      cleanups.push(() => {
        image.removeEventListener("error", handleError);
        image.removeEventListener("load", handleLoad);
        observer?.disconnect();
        cancelViewerImageVisibilityCheck(frame);
      });
    });

    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [active, eagerManagedImages, isVisible, renderableHtml, viewerHtml]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={placeholderMinHeight ? { minHeight: `${placeholderMinHeight}px` } : undefined}
      dangerouslySetInnerHTML={{ __html: isVisible ? viewerHtml : "" }}
    />
  );
}

export function clearRichTextViewerCacheForTests() {
  viewerHtmlCache.clear();
  viewerImagePendingCache.clear();
}

async function hydrateManagedViewerImage(image: HTMLImageElement) {
  const path = image.getAttribute("data-path")?.trim() ?? "";
  const originalSrc =
    image.getAttribute("data-original-src")?.trim() ||
    image.getAttribute("src")?.trim() ||
    "";

  if (!path || image.dataset.thumbnailLoaded === "true") {
    return;
  }

  const displaySrc = await resolveManagedImageDisplaySrc(path, originalSrc);

  if (displaySrc) {
    if (image.getAttribute("src") !== displaySrc) {
      image.setAttribute("src", displaySrc);
    }
  }
}

async function recoverManagedViewerImageSource(
  image: HTMLImageElement,
  onRecovered?: (path: string, displaySrc: string) => void,
) {
  const path = image.getAttribute("data-path")?.trim() ?? "";
  const mimeType = image.getAttribute("data-mime-type")?.trim() ?? undefined;
  const currentSrc = image.getAttribute("src")?.trim() ?? "";

  if (!path || (currentSrc.startsWith("data:") && currentSrc !== TRANSPARENT_IMAGE_DATA_URL)) {
    return;
  }

  const pending = ensureManagedViewerImageDataUrl(path, mimeType);

  try {
    const dataUrl = await pending;
    image.setAttribute("src", dataUrl);
    onRecovered?.(path, dataUrl);
  } catch {
    // Keep the existing image state when file recovery fails.
  }
}

function buildViewerRenderableHtml(html: string) {
  const normalizedHtml = html.trim();

  if (!normalizedHtml || typeof DOMParser === "undefined") {
    return normalizedHtml;
  }

  const doc = new DOMParser().parseFromString(normalizedHtml, "text/html");

  doc.body.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const path = image.getAttribute("data-path")?.trim() ?? "";
    const src = image.getAttribute("src")?.trim() ?? "";
    const thumbnailLoaded = image.getAttribute("data-thumbnail-loaded") === "true";

    if (path && src && !thumbnailLoaded) {
      image.setAttribute("data-original-src", src);
      image.setAttribute("src", TRANSPARENT_IMAGE_DATA_URL);
      applyViewerImagePlaceholderSizing(image);
    }

    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
  });

  return doc.body.innerHTML.trim();
}

function getViewerHtmlForRender(html: string) {
  const normalizedHtml = html.trim();

  if (!normalizedHtml) {
    return normalizedHtml;
  }

  const cachedHtml = readCachedViewerHtml(normalizedHtml);

  if (cachedHtml) {
    return cachedHtml;
  }

  return buildViewerRenderableHtml(normalizedHtml);
}

function readCachedViewerHtml(html: string) {
  pruneViewerHtmlCache();

  const cacheKey = html.trim();
  const entry = viewerHtmlCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  entry.lastUsedAt = Date.now();
  return entry.html;
}

function cacheViewerHtml(html: string, viewerHtml: string) {
  const cacheKey = html.trim();
  const cacheValue = viewerHtml.trim();

  if (!cacheKey || !cacheValue) {
    return;
  }

  pruneViewerHtmlCache();
  viewerHtmlCache.set(cacheKey, {
    html: cacheValue,
    lastUsedAt: Date.now(),
  });

  if (viewerHtmlCache.size <= VIEWER_HTML_CACHE_MAX_ENTRIES) {
    return;
  }

  const oldestEntry = Array.from(viewerHtmlCache.entries()).sort(
    (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
  )[0];

  if (oldestEntry) {
    viewerHtmlCache.delete(oldestEntry[0]);
  }
}

function pruneViewerHtmlCache() {
  const expiresBefore = Date.now() - VIEWER_HTML_CACHE_TTL_MS;

  viewerHtmlCache.forEach((entry, cacheKey) => {
    if (entry.lastUsedAt < expiresBefore) {
      viewerHtmlCache.delete(cacheKey);
    }
  });
}

function replaceViewerImageDisplaySrc(html: string, path: string, displaySrc: string) {
  const normalizedHtml = html.trim();
  const normalizedPath = path.trim();
  const normalizedDisplaySrc = displaySrc.trim();

  if (
    !normalizedHtml ||
    !normalizedPath ||
    !normalizedDisplaySrc ||
    typeof DOMParser === "undefined"
  ) {
    return html;
  }

  const doc = new DOMParser().parseFromString(normalizedHtml, "text/html");
  let changed = false;

  doc.body.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    if (image.getAttribute("data-path")?.trim() !== normalizedPath) {
      return;
    }

    if (!image.getAttribute("data-original-src")) {
      image.setAttribute("data-original-src", image.getAttribute("src")?.trim() ?? "");
    }

    image.setAttribute("src", normalizedDisplaySrc);
    image.setAttribute("data-thumbnail-loaded", "true");
    image.style.minHeight = "";
    image.style.aspectRatio = "";
    changed = true;
  });

  return changed ? doc.body.innerHTML.trim() : html;
}

function applyViewerImagePlaceholderSizing(image: HTMLImageElement) {
  const path = image.getAttribute("data-path")?.trim() ?? "";

  if (!path || image.dataset.thumbnailLoaded === "true") {
    return;
  }

  const width = readViewerImageWidth(image);
  image.style.aspectRatio = image.style.aspectRatio || String(VIEWER_IMAGE_DEFAULT_ASPECT_RATIO);
  image.style.minHeight = width
    ? `${clampViewerImagePlaceholderHeight(
        Math.round(width / VIEWER_IMAGE_DEFAULT_ASPECT_RATIO),
      )}px`
    : `${VIEWER_IMAGE_MIN_HEIGHT}px`;
}

function readViewerImageWidth(image: HTMLImageElement) {
  const widthAttribute = Number.parseFloat(image.getAttribute("width") ?? "");

  if (Number.isFinite(widthAttribute) && widthAttribute > 0) {
    return widthAttribute;
  }

  const styleWidth = Number.parseFloat(image.style.width);

  if (Number.isFinite(styleWidth) && styleWidth > 0) {
    return styleWidth;
  }

  return null;
}

function clampViewerImagePlaceholderHeight(height: number) {
  return Math.min(
    VIEWER_IMAGE_MAX_PLACEHOLDER_HEIGHT,
    Math.max(VIEWER_IMAGE_MIN_HEIGHT, height),
  );
}

function scheduleViewerImageVisibilityCheck(image: HTMLImageElement, onVisible: () => void) {
  if (!image.getAttribute("data-path")) {
    return null;
  }

  if (typeof window === "undefined") {
    onVisible();
    return null;
  }

  const runCheck = () => {
    if (image.dataset.thumbnailLoaded === "true") {
      return;
    }

    if (isViewerImageNearViewport(image)) {
      onVisible();
    }
  };

  if (typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(runCheck);
  }

  return window.setTimeout(runCheck, 0);
}

function cancelViewerImageVisibilityCheck(frame: number | null) {
  if (frame === null || typeof window === "undefined") {
    return;
  }

  if (typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frame);
    return;
  }

  window.clearTimeout(frame);
}

function isViewerImageNearViewport(image: HTMLImageElement) {
  const rect = image.getBoundingClientRect();
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight || 0;

  if (viewportHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  return (
    rect.bottom >= -VIEWER_IMAGE_ROOT_MARGIN_PX &&
    rect.top <= viewportHeight + VIEWER_IMAGE_ROOT_MARGIN_PX
  );
}

function ensureManagedViewerImageDataUrl(path: string, mimeType?: string) {
  const cacheKey = buildViewerImageCacheKey(path, mimeType);
  const pending =
    viewerImagePendingCache.get(cacheKey) ??
    desktopApi.readFileAsDataUrl(path, mimeType).then((dataUrl) => {
      viewerImagePendingCache.delete(cacheKey);
      return dataUrl;
    }).catch((error) => {
      viewerImagePendingCache.delete(cacheKey);
      throw error;
    });

  viewerImagePendingCache.set(cacheKey, pending);
  return pending;
}

function buildViewerImageCacheKey(path: string, mimeType?: string) {
  return `${mimeType ?? ""}::${path}`;
}

function createViewerImageObserver(image: HTMLImageElement, onVisible: () => void) {
  if (!image.getAttribute("data-path")) {
    onVisible();
    return null;
  }

  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return null;
  }

  let loaded = false;
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];

      if (!entry || loaded || (!entry.isIntersecting && entry.intersectionRatio <= 0)) {
        return;
      }

      loaded = true;
      onVisible();
      observer.disconnect();
    },
    {
      root: null,
      rootMargin: "360px 0px",
      threshold: 0.01,
    },
  );

  observer.observe(image);
  return observer;
}
