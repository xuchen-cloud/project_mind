import { mergeAttributes } from "@tiptap/core";
import Image from "@tiptap/extension-image";

export const ManagedImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
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
    };
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
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
