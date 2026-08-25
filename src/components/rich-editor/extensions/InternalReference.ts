import { mergeAttributes, Node } from "@tiptap/core";

import {
  buildInternalReferenceTarget,
  buildInternalReferenceToken,
  getInternalReferenceKindLabel,
} from "../../../lib/internalReferences";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    internalReference: {
      setInternalReference: (attributes: Record<string, unknown>) => ReturnType;
    };
  }
}

export const InternalReference = Node.create({
  name: "internalReference",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      refKind: {
        default: "note",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-ref-kind") ?? "note",
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.refKind ? { "data-ref-kind": attributes.refKind } : {},
      },
      refId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-ref-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.refId ? { "data-ref-id": attributes.refId } : {},
      },
      label: {
        default: "未命名引用",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-label") ?? "未命名引用",
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.label ? { "data-label": attributes.label } : {},
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="internal-reference"]',
      },
      {
        tag: 'a[data-type="internal-reference"]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const reference = buildInternalReferenceTarget({
      kind: asKind(HTMLAttributes["data-ref-kind"]),
      id: asId(HTMLAttributes["data-ref-id"]),
      label: asLabel(HTMLAttributes["data-label"]),
    });

    return [
      "span",
      mergeAttributes({
        "data-type": "internal-reference",
        "data-ref-kind": reference.refKind,
        "data-ref-id": reference.refId,
        "data-label": reference.label,
        class: "internal-reference-chip",
        role: "link",
        "aria-label": `${getInternalReferenceKindLabel(reference.refKind)} ${reference.label}`,
        contenteditable: "false",
      }),
      [
        "span",
        { class: "internal-reference-chip__kind" },
        getInternalReferenceKindLabel(reference.refKind),
      ],
      ["span", { class: "internal-reference-chip__label" }, reference.label],
    ];
  },

  renderText({ node }) {
    return buildInternalReferenceToken({
      refKind: asKind(node.attrs.refKind),
      refId: asId(node.attrs.refId),
      label: asLabel(node.attrs.label),
    });
  },

  addCommands() {
    return {
      setInternalReference:
        (attributes) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: attributes,
          }),
    };
  },
});

function asKind(value: unknown) {
  return value === "todo" || value === "document" ? value : "note";
}

function asId(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function asLabel(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : "未命名引用";
}
