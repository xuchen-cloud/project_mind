import { useEffect, useMemo, useRef, useState } from "react";

import { repairRichTextAssetHtml } from "../../lib/richTextAssets";
import { desktopApi } from "../../services/desktopApi";
import {
  resolveManagedImageDisplaySrc,
  TRANSPARENT_IMAGE_DATA_URL,
} from "./imageThumbnails";

const viewerImagePendingCache = new Map<string, Promise<string>>();

interface RichTextViewerProps {
  html?: string | null;
  className?: string;
  deferUntilVisible?: boolean;
  active?: boolean;
}

export function RichTextViewer({
  html,
  className = "rich-editor__surface ProseMirror",
  deferUntilVisible = false,
  active = true,
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
    buildViewerRenderableHtml(deferUntilVisible ? "" : repairRichTextAssetHtml(rawHtml)),
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
    setViewerHtml(buildViewerRenderableHtml(renderableHtml));
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

    container.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
      image.decoding = "async";
      image.loading = "lazy";
      image.style.maxWidth = "100%";
      image.style.height = "auto";

      const handleError = () => {
        void recoverManagedViewerImageSource(image);
      };
      const loadImage = () => {
        void hydrateManagedViewerImage(image);
      };
      const observer = createViewerImageObserver(image, loadImage);

      image.addEventListener("error", handleError);
      cleanups.push(() => {
        image.removeEventListener("error", handleError);
        observer?.disconnect();
      });
    });

    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [active, isVisible, viewerHtml]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={placeholderMinHeight ? { minHeight: `${placeholderMinHeight}px` } : undefined}
      dangerouslySetInnerHTML={{ __html: isVisible ? viewerHtml : "" }}
    />
  );
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
    image.dataset.thumbnailLoaded = "true";
  }
}

async function recoverManagedViewerImageSource(image: HTMLImageElement) {
  const path = image.getAttribute("data-path")?.trim() ?? "";
  const mimeType = image.getAttribute("data-mime-type")?.trim() ?? undefined;
  const currentSrc = image.getAttribute("src")?.trim() ?? "";

  if (!path || (currentSrc.startsWith("data:") && currentSrc !== TRANSPARENT_IMAGE_DATA_URL)) {
    return;
  }

  const pending = ensureManagedViewerImageDataUrl(path, mimeType);

  try {
    image.setAttribute("src", await pending);
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

    if (path && src) {
      image.setAttribute("data-original-src", src);
      image.setAttribute("src", TRANSPARENT_IMAGE_DATA_URL);
    }

    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
  });

  return doc.body.innerHTML.trim();
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
