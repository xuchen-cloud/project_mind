import { mergeAttributes, Node } from "@tiptap/core";

import { tagColorValue } from "../../../lib/constants";
import {
  buildTagMentionTarget,
  buildTagMentionToken,
} from "../../../lib/tagMentions";
import type { TagColorKey } from "../../../lib/types";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tagMention: {
      setTagMention: (attributes: Record<string, unknown>) => ReturnType;
    };
  }
}

export const TagMention = Node.create({
  name: "tagMention",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      tagId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-tag-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.tagId ? { "data-tag-id": attributes.tagId } : {},
      },
      label: {
        default: "未命名标签",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-label") ?? "未命名标签",
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.label ? { "data-label": attributes.label } : {},
      },
      colorKey: {
        default: "slate",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-color-key") ?? "slate",
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.colorKey ? { "data-color-key": attributes.colorKey } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="tag-mention"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const tag = buildTagMentionTarget({
      tagId: asId(HTMLAttributes["data-tag-id"]),
      label: asLabel(HTMLAttributes["data-label"]),
      colorKey: asColorKey(HTMLAttributes["data-color-key"]),
    });
    const color = tagColorValue(asColorKey(tag.colorKey));

    return [
      "span",
      mergeAttributes({
        "data-type": "tag-mention",
        "data-tag-id": tag.tagId,
        "data-label": tag.label,
        "data-color-key": tag.colorKey,
        class: "tag-mention-chip",
        "aria-label": `标签 ${tag.label}`,
        contenteditable: "false",
        style: `background-color: color-mix(in srgb, ${color} 12%, transparent); color: ${color};`,
      }),
      ["span", { class: "tag-mention-chip__sigil" }, "#"],
      ["span", { class: "tag-mention-chip__label" }, tag.label],
    ];
  },

  renderText({ node }) {
    return buildTagMentionToken({
      tagId: asId(node.attrs.tagId),
      label: asLabel(node.attrs.label),
      colorKey: asColorKey(node.attrs.colorKey),
    });
  },

  addCommands() {
    return {
      setTagMention:
        (attributes) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: attributes,
          }),
    };
  },
});

function asId(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function asLabel(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : "未命名标签";
}

function asColorKey(value: unknown) {
  return (
    typeof value === "string" && value.trim().length > 0
      ? value
      : "slate"
  ) as TagColorKey;
}
