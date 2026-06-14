import {
  mergeAttributes,
  ResizableNodeView,
  type NodeViewRendererProps,
} from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { NodeSelection } from "@tiptap/pm/state";
import { resolveRichTextImageSrc } from "../../../lib/richTextAssets";
import { desktopApi } from "../../../services/desktopApi";
import { buildImageAnnotationPreviewMarkup } from "../image-annotations";

const MIN_IMAGE_WIDTH = 120;
const MIN_IMAGE_HEIGHT = 60;
const LAZY_IMAGE_ROOT_MARGIN = "240px 0px";
const DEFAULT_PLACEHOLDER_ASPECT_RATIO = 3 / 2;
const TRANSPARENT_IMAGE_DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

export const ManagedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          resolveRichTextImageSrc(element.getAttribute("data-path"), element.getAttribute("src")),
        renderHTML: (attributes: Record<string, unknown>) => {
          const nextSrc = resolveRichTextImageSrc(
            asOptionalString(attributes.path),
            asOptionalString(attributes.src),
          );

          return nextSrc ? { src: nextSrc } : {};
        },
      },
      path: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-path"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.path ? { "data-path": attributes.path } : {},
      },
      mimeType: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-mime-type"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.mimeType ? { "data-mime-type": attributes.mimeType } : {},
      },
      documentId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-document-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.documentId ? { "data-document-id": attributes.documentId } : {},
      },
      width: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          parsePixelWidth(element.getAttribute("width")) ?? parsePixelWidth(element.style.width),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.width === "number" ? { width: attributes.width } : {},
      },
      annotationState: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-annotation-state"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes.annotationState === "string" && attributes.annotationState.trim().length > 0
            ? { "data-annotation-state": attributes.annotationState }
            : {},
      },
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },

  addNodeView() {
    return (props: NodeViewRendererProps) => {
      const { node, editor, getPos, HTMLAttributes } = props;
      const image = document.createElement("img");
      const annotationOverlay = document.createElement("div");

      let currentNode = node;
      let recoveringSrc = false;
      let hasActivatedSource = typeof IntersectionObserver === "undefined";
      let hasResolvedImageSource = false;
      let knownAspectRatio: number | null = null;
      let observer: IntersectionObserver | null = null;
      let resizeObserver: ResizeObserver | null = null;
      let cleanupViewportResize: (() => void) | null = null;
      let scheduledSyncFrame: number | null = null;

      image.decoding = "async";
      image.loading = "eager";

      const scheduleSyncImage = () => {
        if (scheduledSyncFrame !== null) {
          return;
        }

        scheduledSyncFrame = window.requestAnimationFrame(() => {
          scheduledSyncFrame = null;
          syncImage();
        });
      };

      const syncImage = (nextNode = currentNode) => {
        const resolvedSrc = resolveRichTextImageSrc(
          asOptionalString(nextNode.attrs.path),
          asOptionalString(nextNode.attrs.src),
        );
        const nextPath = asOptionalString(nextNode.attrs.path);

        hasResolvedImageSource = Boolean(resolvedSrc);
        syncManagedImageSource(
          image,
          hasActivatedSource || !resolvedSrc ? resolvedSrc : TRANSPARENT_IMAGE_DATA_URL,
          resolvedSrc,
          nextPath,
        );
        setAttribute(image, "alt", nextNode.attrs.alt);
        setAttribute(image, "title", nextNode.attrs.title);
        setAttribute(image, "data-path", nextPath);
        setAttribute(image, "data-mime-type", nextNode.attrs.mimeType);
        setAttribute(image, "data-document-id", nextNode.attrs.documentId);
        setAttribute(image, "data-annotation-state", nextNode.attrs.annotationState);
        image.className = [this.options.HTMLAttributes?.class, HTMLAttributes.class]
          .filter(Boolean)
          .join(" ");
        const clampedWidth = clampImageWidthToContainer(nextNode, image);
        image.style.width =
          typeof clampedWidth === "number" && clampedWidth > 0 ? `${clampedWidth}px` : "";
        image.style.maxWidth = "100%";
        image.style.height = "auto";
        image.dataset.lazyMounted = String(hasActivatedSource || !resolvedSrc);
        applyPlaceholderSizing(nextNode);

      };

      const syncAnnotation = (nextNode = currentNode) => {
        const markup = buildImageAnnotationPreviewMarkup(asOptionalString(nextNode.attrs.annotationState));

        annotationOverlay.className = "rich-editor__annotation-preview";
        annotationOverlay.setAttribute("aria-hidden", "true");
        annotationOverlay.hidden = markup.length === 0;
        annotationOverlay.innerHTML = markup;
      };

      const recoverImageSource = async () => {
        if (recoveringSrc) {
          return;
        }

        const path = asOptionalString(currentNode.attrs.path);

        if (!path) {
          return;
        }

        const currentSrc = asOptionalString(currentNode.attrs.src);

        if (currentSrc && currentSrc.trim().startsWith("data:")) {
          return;
        }

        recoveringSrc = true;

        try {
          const dataUrl = await desktopApi.readFileAsDataUrl(
            path,
            asOptionalString(currentNode.attrs.mimeType) ?? undefined,
          );

          image.setAttribute("src", dataUrl);
        } catch {
          // Leave the existing broken-image state if recovery also fails.
        } finally {
          recoveringSrc = false;
        }
      };

      const handleImageLoad = () => {
        if (image.currentSrc === TRANSPARENT_IMAGE_DATA_URL || image.getAttribute("src") === TRANSPARENT_IMAGE_DATA_URL) {
          return;
        }

        const naturalWidth = image.naturalWidth || image.width;
        const naturalHeight = image.naturalHeight || image.height;

        if (naturalWidth > 0 && naturalHeight > 0) {
          knownAspectRatio = naturalWidth / naturalHeight;
        }

        applyPlaceholderSizing();
      };

      syncImage(node);
      const handleImageError = () => {
        void recoverImageSource();
      };
      image.addEventListener("error", handleImageError);
      image.addEventListener("load", handleImageLoad);

      const view = new ResizableNodeView({
        element: image,
        node,
        editor,
        getPos: () => safeGetPos(getPos) ?? 0,
        onResize: (width) => {
          image.style.width = `${width}px`;
        },
        onCommit: (width) => {
          const pos = typeof getPos === "function" ? safeGetPos(getPos) : undefined;

          if (typeof pos !== "number") {
            return;
          }

          const nextAttrs = {
            ...currentNode.attrs,
            width: Math.max(MIN_IMAGE_WIDTH, Math.round(width)),
          };
          const tr = editor.state.tr;

          tr.setSelection(NodeSelection.create(tr.doc, pos));
          tr.setNodeMarkup(pos, undefined, nextAttrs);
          editor.view.dispatch(tr);
        },
        onUpdate: (updatedNode) => {
          currentNode = updatedNode;
          syncImage(updatedNode);
          syncAnnotation(updatedNode);
          return true;
        },
        options: {
          directions: ["bottom-right"],
          preserveAspectRatio: true,
          min: {
            width: MIN_IMAGE_WIDTH,
            height: MIN_IMAGE_HEIGHT,
          },
          className: {
            container: "rich-editor__image-node",
            wrapper: "rich-editor__image-wrapper",
            handle: "rich-editor__resize-handle rich-editor__image-resize-handle",
            resizing: "is-resizing",
          },
          createCustomHandle: () => {
            const handle = document.createElement("button");

            handle.type = "button";
            handle.className = "rich-editor__resize-handle rich-editor__image-resize-handle";
            handle.setAttribute("aria-label", "调整图片大小");
            handle.setAttribute("title", "调整图片大小");
            handle.dataset.resizeHandle = "bottom-right";

            return handle;
          },
        },
      });

      const wrapper = view.dom.querySelector<HTMLElement>(".rich-editor__image-wrapper") ?? view.dom;
      observer = createLazyImageObserver(wrapper, (visible) => {
        if (!visible || hasActivatedSource) {
          return;
        }

        hasActivatedSource = true;
        syncImage();
      });
      resizeObserver = createImageResizeObserver(wrapper, scheduleSyncImage);
      cleanupViewportResize = createViewportResizeSubscription(scheduleSyncImage);

      wrapper.append(annotationOverlay);
      syncAnnotation(node);
      scheduleSyncImage();

      return {
        dom: view.dom,
        update: view.update.bind(view),
        destroy: () => {
          if (scheduledSyncFrame !== null) {
            window.cancelAnimationFrame(scheduledSyncFrame);
          }
          image.removeEventListener("error", handleImageError);
          image.removeEventListener("load", handleImageLoad);
          observer?.disconnect();
          resizeObserver?.disconnect();
          cleanupViewportResize?.();
          view.destroy();
        },
        stopEvent: (event: Event) =>
          event.target instanceof HTMLElement &&
          event.target.closest(".rich-editor__image-resize-handle") !== null,
        selectNode: () => {
          view.dom.classList.add("ProseMirror-selectednode");
        },
        deselectNode: () => {
          view.dom.classList.remove("ProseMirror-selectednode");
        },
      };

      function applyPlaceholderSizing(nextNode = currentNode) {
        if (hasActivatedSource || !hasResolvedImageSource) {
          image.style.minHeight = "";
          image.style.aspectRatio = "";
          return;
        }

        const width =
          clampImageWidthToContainer(nextNode, image) ?? null;
        const aspectRatio = knownAspectRatio ?? DEFAULT_PLACEHOLDER_ASPECT_RATIO;

        image.style.aspectRatio = String(aspectRatio);
        image.style.minHeight = width
          ? `${Math.max(MIN_IMAGE_HEIGHT, Math.round(width / aspectRatio))}px`
          : `${MIN_IMAGE_HEIGHT}px`;
      }
    };
  },

  renderText({ node }) {
    const label =
      (typeof node.attrs.alt === "string" && node.attrs.alt.trim().length > 0
        ? node.attrs.alt
        : null) ??
      (typeof node.attrs.title === "string" && node.attrs.title.trim().length > 0
        ? node.attrs.title
        : null) ??
      "图片";

    return `[图片] ${label}`;
  },
});

function parsePixelWidth(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const match = value.match(/([0-9]+(?:\.[0-9]+)?)(?:\s*px)?/i);

  if (!match) {
    return null;
  }

  return Math.round(Number(match[1]));
}

function safeGetPos(getPos: () => number | undefined) {
  try {
    return getPos();
  } catch {
    return undefined;
  }
}

function asOptionalString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function setAttribute(element: HTMLElement, name: string, value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) {
    element.setAttribute(name, value);
    return;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    element.setAttribute(name, String(value));
    return;
  }

  element.removeAttribute(name);
}

function createLazyImageObserver(
  target: Element,
  onVisibilityChange: (visible: boolean) => void,
) {
  if (typeof IntersectionObserver === "undefined") {
    onVisibilityChange(true);
    return null;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];

      if (!entry) {
        return;
      }

      onVisibilityChange(entry.isIntersecting || entry.intersectionRatio > 0);
    },
    {
      root: null,
      rootMargin: LAZY_IMAGE_ROOT_MARGIN,
      threshold: 0.01,
    },
  );

  observer.observe(target);
  return observer;
}

function createImageResizeObserver(
  target: HTMLElement,
  onResize: () => void,
) {
  if (typeof ResizeObserver === "undefined") {
    return null;
  }

  const observer = new ResizeObserver(() => {
    onResize();
  });
  const editorSurface = target.closest(".rich-editor__surface");

  if (editorSurface instanceof HTMLElement) {
    observer.observe(editorSurface);
    return observer;
  }

  observer.observe(target);
  return observer;
}

function createViewportResizeSubscription(onResize: () => void) {
  if (typeof window === "undefined") {
    return null;
  }

  const visualViewport = window.visualViewport;

  window.addEventListener("resize", onResize);
  visualViewport?.addEventListener("resize", onResize);

  return () => {
    window.removeEventListener("resize", onResize);
    visualViewport?.removeEventListener("resize", onResize);
  };
}

function clampImageWidthToContainer(
  node: { attrs: { width?: unknown } },
  image: HTMLImageElement,
) {
  const desiredWidth =
    typeof node.attrs.width === "number" && node.attrs.width > 0
      ? node.attrs.width
      : null;

  if (desiredWidth === null) {
    return null;
  }

  const editorSurface = image.closest(".rich-editor__surface");
  const availableWidth = editorSurface instanceof HTMLElement
    ? Math.floor(
      editorSurface.clientWidth
        - readComputedPixelValue(editorSurface, "padding-left")
        - readComputedPixelValue(editorSurface, "padding-right"),
    )
    : 0;

  if (availableWidth <= 0) {
    return desiredWidth;
  }

  return Math.max(1, Math.min(desiredWidth, availableWidth));
}

function readComputedPixelValue(element: HTMLElement, property: string) {
  const value = window.getComputedStyle(element).getPropertyValue(property);
  const numeric = Number.parseFloat(value);

  return Number.isFinite(numeric) ? numeric : 0;
}

function syncManagedImageSource(
  image: HTMLImageElement,
  nextSrc: string | null,
  resolvedSrc: string | null,
  nextPath: string | null,
) {
  const currentSrc = image.getAttribute("src")?.trim() ?? "";
  const currentPath = image.getAttribute("data-path")?.trim() ?? "";
  const normalizedNextSrc = nextSrc?.trim() ?? "";
  const normalizedNextPath = nextPath?.trim() ?? "";
  const shouldPreserveRecoveredDataUrl =
    currentSrc.startsWith("data:")
    && currentSrc !== TRANSPARENT_IMAGE_DATA_URL
    && Boolean(resolvedSrc)
    && currentPath.length > 0
    && currentPath === normalizedNextPath
    && normalizedNextSrc === resolvedSrc;

  if (shouldPreserveRecoveredDataUrl || currentSrc === normalizedNextSrc) {
    return;
  }

  setAttribute(image, "src", nextSrc);
}
