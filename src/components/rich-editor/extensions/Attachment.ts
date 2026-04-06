import { mergeAttributes, Node } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    attachment: {
      setAttachment: (attributes: Record<string, unknown>) => ReturnType;
    };
  }
}

export const Attachment = Node.create({
  name: "attachment",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  isolating: true,

  addAttributes() {
    return {
      title: {
        default: "未命名文件",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-title"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.title ? { "data-title": attributes.title } : {},
      },
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-href"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.href ? { "data-href": attributes.href } : {},
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
      meta: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-meta"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.meta ? { "data-meta": attributes.meta } : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="attachment"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const dataTitle = HTMLAttributes["data-title"];
    const dataMeta = HTMLAttributes["data-meta"];
    const dataHref = HTMLAttributes["data-href"];
    const title =
      typeof dataTitle === "string" && dataTitle.trim().length > 0
        ? dataTitle
        : "未命名文件";
    const meta =
      typeof dataMeta === "string" && dataMeta.trim().length > 0
        ? dataMeta
        : null;
    const href =
      typeof dataHref === "string" && dataHref.trim().length > 0
        ? dataHref
        : "#";
    const isFallbackLink = href === "#";
    const linkAttributes = isFallbackLink
      ? {
          class: "rich-editor__attachment-link",
          href,
          "data-rich-editor-openable": "true",
        }
      : {
          class: "rich-editor__attachment-link",
          href,
          target: "_blank",
          rel: "noreferrer noopener",
          "data-rich-editor-openable": "true",
        };

    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "attachment",
        class: "rich-editor__attachment",
        contenteditable: "false",
      }),
      [
        "a",
        linkAttributes,
        ["span", { class: "rich-editor__attachment-glyph", "aria-hidden": "true" }, "FILE"],
        [
          "span",
          { class: "rich-editor__attachment-body" },
          ["strong", { class: "rich-editor__attachment-title" }, title],
          meta ? ["span", { class: "rich-editor__attachment-meta" }, meta] : ["span", { class: "rich-editor__attachment-meta" }, "附件"],
        ],
      ],
    ];
  },

  renderText({ node }) {
    const title =
      typeof node.attrs.title === "string" && node.attrs.title.trim().length > 0
        ? node.attrs.title
        : "未命名文件";
    return `[附件] ${title}`;
  },

  addCommands() {
    return {
      setAttachment:
        (attributes) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: attributes,
          }),
    };
  },
});
