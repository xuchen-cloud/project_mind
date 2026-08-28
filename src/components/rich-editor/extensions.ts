import StarterKit from "@tiptap/starter-kit";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import { Extension, getSchema } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { Attachment } from "./extensions/Attachment";
import { ContactMention } from "./extensions/ContactMention";
import { InternalReference } from "./extensions/InternalReference";
import { ManagedImage } from "./extensions/ManagedImage";
import { ManagedTable } from "./extensions/ManagedTable";
import { TagMention } from "./extensions/TagMention";
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

export function buildRichEditorExtensions(placeholder: string) {
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
    ManagedTable.configure({
      cellMinWidth: 48,
      renderWrapper: true,
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    ManagedImage.configure({
      allowBase64: true,
      HTMLAttributes: {
        class: "rich-editor__image",
      },
    }),
    InternalReference,
    ContactMention,
    TagMention,
    Attachment,
    CodeBlockLanguageMetadata,
    CodeHighlightDecorations,
  ];
}

export const richEditorSchema = getSchema(buildRichEditorExtensions(""));
