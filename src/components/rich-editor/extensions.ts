import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import { isSafeRecordLink } from "../../lib/record-document";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import { Extension, getSchema, type Attributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { Attachment } from "./extensions/Attachment";
import { ContactMention } from "./extensions/ContactMention";
import { InternalReference } from "./extensions/InternalReference";
import { ManagedImage } from "./extensions/ManagedImage";
import { ManagedTable } from "./extensions/ManagedTable";
import { TagMention } from "./extensions/TagMention";
import { StableRecordBlocks, type RecordClipboardOptions } from "./extensions/StableRecordBlocks";
import { codeLanguageLabel, highlightCodeRanges, normalizeCodeLanguage } from "./codeHighlight";

export const RICH_EDITOR_CODE_LANGUAGE_OPEN_EVENT =
  "project-mind-rich-editor-code-language-open";

const CodeBlockLanguageMetadata = Extension.create({
  name: "codeBlockLanguageMetadata",

  addGlobalAttributes() {
    return [
      {
        types: ["codeBlock"],
        attributes: {
          languageExplicit: {
            default: false,
            parseHTML: (element) => {
              const explicitValue = element.getAttribute("data-language-explicit");

              if (explicitValue === "true") {
                return true;
              }

              if (explicitValue === "false") {
                return false;
              }

              return Boolean(
                element.getAttribute("data-language") ||
                  element.querySelector("code[class*='language-']"),
              );
            },
            renderHTML: (attributes) =>
              attributes.languageExplicit
                ? { "data-language-explicit": "true" }
                : { "data-language-explicit": "false" },
          },
        },
      },
    ];
  },
});

const CodeHighlightDecorations = Extension.create({
  name: "codeHighlightDecorations",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations(state) {
            const decorations: Decoration[] = [];

            state.doc.descendants((node, pos) => {
              if (node.type.name !== "codeBlock") {
                return true;
              }

              const language = normalizeCodeLanguage(
                typeof node.attrs.language === "string" ? node.attrs.language : node.attrs.params,
              );
              const code = node.textContent;

              highlightCodeRanges(code, language).forEach((range) => {
                decorations.push(
                  Decoration.inline(pos + 1 + range.from, pos + 1 + range.to, {
                    class: range.className,
                  }),
                );
              });

              decorations.push(
                Decoration.widget(
                  pos + 1,
                  () => {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "rich-editor__inline-code-language-button";
                    button.textContent = codeLanguageLabel(language);
                    button.addEventListener("mousedown", (event) => {
                      if (event.button !== 0) {
                        return;
                      }

                      event.preventDefault();
                      event.stopPropagation();
                      button.dispatchEvent(
                        new CustomEvent(RICH_EDITOR_CODE_LANGUAGE_OPEN_EVENT, {
                          bubbles: true,
                          detail: { mode: "select", pos },
                        }),
                      );
                    });
                    button.addEventListener("contextmenu", (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      button.dispatchEvent(
                        new CustomEvent(RICH_EDITOR_CODE_LANGUAGE_OPEN_EVENT, {
                          bubbles: true,
                          detail: { mode: "document", pos },
                        }),
                      );
                    });
                    return button;
                  },
                  {
                    key: `code-language-${pos}-${language}`,
                    side: -1,
                    ignoreSelection: true,
                  },
                ),
              );

              return false;
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});

export function buildRichEditorExtensions(placeholder: string, options: RecordClipboardOptions & { stableBlocks?: boolean; portableAssets?: boolean; recordKey?: string } = {}) {
  const image = options.portableAssets ? ManagedImage.extend({
    addAttributes() {
      const attributes: Attributes = this.parent?.() ?? {};
      return { ...attributes, src: { ...attributes.src, parseHTML: (element: HTMLElement) => element.getAttribute("src") } };
    },
  }) : ManagedImage;
  const attachment = options.portableAssets ? Attachment.extend({
    addAttributes() {
      const attributes: Attributes = this.parent?.() ?? {};
      return { ...attributes, href: { ...attributes.href, parseHTML: (element: HTMLElement) => element.getAttribute("data-href") ?? element.getAttribute("href") } };
    },
  }) : Attachment;
  const table = options.portableAssets ? ManagedTable.extend({
    addAttributes() {
      const attributes: Attributes = this.parent?.() ?? {};
      return { ...attributes, style: { ...attributes.style,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-style-derived") === "true"
          ? null : attributes.style?.parseHTML?.(element) ?? null } };
    },
    renderHTML(props) {
      const spec = this.parent?.(props);
      if (!spec) throw new Error("Missing table renderer");
      if (!props.node.attrs.style) {
        const mark = (output: unknown) => {
          if (!Array.isArray(output)) return;
          if (output[0] === "table") output[1] = { ...output[1], "data-style-derived": "true" };
          else output.slice(1).forEach((child) => { if (Array.isArray(child)) mark(child); });
        };
        mark(spec);
      }
      return spec;
    },
  }) : ManagedTable;
  return [
    StarterKit.configure({
      link: false,
      heading: {
        levels: [1, 2, 3, 4],
      },
      codeBlock: {
        HTMLAttributes: {
          class: "rich-editor__code-block",
        },
      },
    }),
    Highlight.configure({
      multicolor: false,
      HTMLAttributes: {
        class: "rich-editor__highlight",
      },
    }),
    Link.configure({
      openOnClick: false,
      isAllowedUri: isSafeRecordLink,
      HTMLAttributes: {
        class: "rich-editor__link",
      },
    }),
    Placeholder.configure({
      placeholder,
      emptyEditorClass: "is-editor-empty",
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    table.configure({
      cellMinWidth: 48,
      renderWrapper: true,
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    image.configure({
      allowBase64: true,
      HTMLAttributes: {
        class: "rich-editor__image",
      },
    }),
    InternalReference,
    ContactMention,
    TagMention,
    attachment,
    CodeBlockLanguageMetadata,
    CodeHighlightDecorations,
    ...(options.stableBlocks ? [StableRecordBlocks.configure({ recordKey: options.recordKey ?? null,
      clipboardPayload: options.clipboardPayload, onCopied: options.onCopied,
      cutTransport: options.cutTransport, pasteCut: options.pasteCut })] : []),
  ];
}

export const richEditorSchema = getSchema(buildRichEditorExtensions(""));
export const recordDocumentSchema = getSchema(buildRichEditorExtensions("", { stableBlocks: true, portableAssets: true }));
