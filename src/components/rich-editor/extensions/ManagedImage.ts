import {
  mergeAttributes,
  ResizableNodeView,
  type NodeViewRendererProps,
} from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { NodeSelection } from "@tiptap/pm/state";
import { resolveRichTextImageSrc } from "../../../lib/richTextAssets";
import { desktopApi } from "../../../services/desktopApi";

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
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
  },

  addNodeView() {
    return (props: NodeViewRendererProps) => {
      const { node, editor, getPos, HTMLAttributes } = props;
      const image = document.createElement("img");

      let currentNode = node;
      let recoveringSrc = false;

      const syncImage = (nextNode = currentNode) => {
        setAttribute(
          image,
          "src",
          resolveRichTextImageSrc(
            asOptionalString(nextNode.attrs.path),
            asOptionalString(nextNode.attrs.src),
          ),
        );
        setAttribute(image, "alt", nextNode.attrs.alt);
        setAttribute(image, "title", nextNode.attrs.title);
        setAttribute(image, "data-path", nextNode.attrs.path);
        setAttribute(image, "data-mime-type", nextNode.attrs.mimeType);
        setAttribute(image, "data-document-id", nextNode.attrs.documentId);
        image.className = [this.options.HTMLAttributes?.class, HTMLAttributes.class]
          .filter(Boolean)
          .join(" ");
        image.style.width =
          typeof nextNode.attrs.width === "number" ? `${nextNode.attrs.width}px` : "";
        image.style.maxWidth = "100%";
        image.style.height = "auto";
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

          const pos = typeof getPos === "function" ? safeGetPos(getPos) : undefined;

          if (typeof pos !== "number" || !editor.isEditable) {
            return;
          }

          const nextAttrs = {
            ...currentNode.attrs,
            src: dataUrl,
          };
          const tr = editor.state.tr;

          tr.setSelection(NodeSelection.create(tr.doc, pos));
          tr.setNodeMarkup(pos, undefined, nextAttrs);
          editor.view.dispatch(tr);
        } catch {
          // Leave the existing broken-image state if recovery also fails.
        } finally {
          recoveringSrc = false;
        }
      };

      syncImage(node);
      const handleImageError = () => {
        void recoverImageSource();
      };
      image.addEventListener("error", handleImageError);

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

      return {
        dom: view.dom,
        update: view.update.bind(view),
        destroy: () => {
          image.removeEventListener("error", handleImageError);
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

const MIN_IMAGE_WIDTH = 120;
const MIN_IMAGE_HEIGHT = 60;

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
