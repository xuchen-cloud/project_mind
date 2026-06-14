import { useEffect, useMemo, useRef, useState } from "react";

import { repairRichTextAssetHtml } from "../../lib/richTextAssets";
import { desktopApi } from "../../services/desktopApi";

const viewerImageDataUrlCache = new Map<string, string>();
const viewerImagePendingCache = new Map<string, Promise<string>>();

interface RichTextViewerProps {
  html?: string | null;
  className?: string;
  deferUntilVisible?: boolean;
}

export function RichTextViewer({
  html,
  className = "rich-editor__surface ProseMirror",
  deferUntilVisible = false,
}: RichTextViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderableHtml = useMemo(() => repairRichTextAssetHtml(html), [html]);
  const [viewerHtml, setViewerHtml] = useState(() => buildViewerHydratedHtml(renderableHtml));
  const [isVisible, setIsVisible] = useState(!deferUntilVisible);
  const placeholderMinHeight = useMemo(() => {
    if (!deferUntilVisible || isVisible || !renderableHtml) {
      return undefined;
    }

    return /<img\b/i.test(renderableHtml) ? 180 : 72;
  }, [deferUntilVisible, isVisible, renderableHtml]);

  useEffect(() => {
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
  }, [deferUntilVisible, isVisible]);

  useEffect(() => {
    setViewerHtml(buildViewerHydratedHtml(renderableHtml));
  }, [renderableHtml]);

  useEffect(() => {
    if (!isVisible) {
      return;
    }

    const container = containerRef.current;

    if (!container) {
      return;
    }

    const cleanups: Array<() => void> = [];
    let cancelled = false;

    container.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
      image.decoding = "async";
      image.style.maxWidth = "100%";
      image.style.height = "auto";

      const handleError = () => {
        void hydrateManagedViewerImage(image);
      };

      image.addEventListener("error", handleError);
      cleanups.push(() => image.removeEventListener("error", handleError));
      void hydrateManagedViewerImage(image);
    });

    void hydrateManagedViewerHtml(renderableHtml).then((nextHtml) => {
      if (cancelled) {
        return;
      }

      setViewerHtml(nextHtml);
    });

    return () => {
      cancelled = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [isVisible, renderableHtml]);

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
  const mimeType = image.getAttribute("data-mime-type")?.trim() ?? undefined;
  const currentSrc = image.getAttribute("src")?.trim() ?? "";

  if (!path || currentSrc.startsWith("data:")) {
    return;
  }

  const cacheKey = `${mimeType ?? ""}::${path}`;
  const cached = viewerImageDataUrlCache.get(cacheKey);

  if (cached) {
    image.setAttribute("src", cached);
    return;
  }

  const pending = ensureManagedViewerImageDataUrl(path, mimeType);

  try {
    image.setAttribute("src", await pending);
  } catch {
    // Keep the existing image state when file recovery fails.
  }
}

async function hydrateManagedViewerHtml(html: string) {
  const normalizedHtml = html.trim();

  if (!normalizedHtml || typeof DOMParser === "undefined") {
    return normalizedHtml;
  }

  const doc = new DOMParser().parseFromString(normalizedHtml, "text/html");
  const hydrationTasks: Promise<unknown>[] = [];

  doc.body.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const path = image.getAttribute("data-path")?.trim() ?? "";
    const mimeType = image.getAttribute("data-mime-type")?.trim() ?? undefined;

    if (!path) {
      return;
    }

    const cached = viewerImageDataUrlCache.get(buildViewerImageCacheKey(path, mimeType));

    if (cached) {
      image.setAttribute("src", cached);
      return;
    }

    hydrationTasks.push(
      ensureManagedViewerImageDataUrl(path, mimeType).then((dataUrl) => {
        image.setAttribute("src", dataUrl);
      }).catch(() => {
        // Leave the current src untouched when hydration fails.
      }),
    );
  });

  if (hydrationTasks.length === 0) {
    return doc.body.innerHTML.trim();
  }

  await Promise.all(hydrationTasks);
  return doc.body.innerHTML.trim();
}

function buildViewerHydratedHtml(html: string) {
  const normalizedHtml = html.trim();

  if (!normalizedHtml || typeof DOMParser === "undefined") {
    return normalizedHtml;
  }

  const doc = new DOMParser().parseFromString(normalizedHtml, "text/html");

  doc.body.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const path = image.getAttribute("data-path")?.trim() ?? "";
    const mimeType = image.getAttribute("data-mime-type")?.trim() ?? undefined;

    if (!path) {
      return;
    }

    const cached = viewerImageDataUrlCache.get(buildViewerImageCacheKey(path, mimeType));

    if (cached) {
      image.setAttribute("src", cached);
    }
  });

  return doc.body.innerHTML.trim();
}

function ensureManagedViewerImageDataUrl(path: string, mimeType?: string) {
  const cacheKey = buildViewerImageCacheKey(path, mimeType);
  const cached = viewerImageDataUrlCache.get(cacheKey);

  if (cached) {
    return Promise.resolve(cached);
  }

  const pending =
    viewerImagePendingCache.get(cacheKey) ??
    desktopApi.readFileAsDataUrl(path, mimeType).then((dataUrl) => {
      viewerImageDataUrlCache.set(cacheKey, dataUrl);
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
