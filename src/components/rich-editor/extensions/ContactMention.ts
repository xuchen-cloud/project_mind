import { mergeAttributes, Node } from "@tiptap/core";

import {
  buildContactMentionTarget,
  buildContactMentionToken,
} from "../../../lib/contactMentions";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    contactMention: {
      setContactMention: (attributes: Record<string, unknown>) => ReturnType;
    };
  }
}

export const ContactMention = Node.create({
  name: "contactMention",
  priority: 1000,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      contactId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-contact-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.contactId ? { "data-contact-id": attributes.contactId } : {},
      },
      label: {
        default: "未命名联系人",
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-label") ?? "未命名联系人",
        renderHTML: (attributes: Record<string, unknown>) =>
          attributes.label ? { "data-label": attributes.label } : {},
      },
    };
  },

  parseHTML() {
    return [
      { tag: 'span[data-type="contact-mention"]' },
      { tag: 'a[data-type="contact-mention"]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const mention = buildContactMentionTarget({
      contactId: asId(HTMLAttributes["data-contact-id"]),
      label: asLabel(HTMLAttributes["data-label"]),
    });

    return [
      "span",
      mergeAttributes({
        "data-type": "contact-mention",
        "data-contact-id": mention.contactId,
        "data-label": mention.label,
        class: "contact-mention-chip",
        role: "link",
        "aria-label": `联系人 ${mention.label}`,
        contenteditable: "false",
      }),
      ["span", { class: "contact-mention-chip__sigil" }, "@"],
      ["span", { class: "contact-mention-chip__label" }, mention.label],
    ];
  },

  renderText({ node }) {
    return buildContactMentionToken({
      contactId: asId(node.attrs.contactId),
      label: asLabel(node.attrs.label),
    });
  },

  addCommands() {
    return {
      setContactMention:
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
  return typeof value === "string" && value.trim().length > 0 ? value : "未命名联系人";
}
