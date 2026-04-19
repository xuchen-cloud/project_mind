import type { Editor } from "@tiptap/core";
import type { Mark, Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  MarkdownSerializer,
  type MarkdownSerializerState,
} from "@tiptap/pm/markdown";

import {
  EMPTY_RICH_TEXT_HTML,
  getRenderableRichTextHtml,
  renderMarkdownToHtml,
} from "../../lib/richTextContent";
import { buildInternalReferenceToken } from "../../lib/internalReferences";

export const EMPTY_RICH_EDITOR_HTML = EMPTY_RICH_TEXT_HTML;
export { getRenderableRichTextHtml, renderMarkdownToHtml };
type MarkdownStateWithAutolink = MarkdownSerializerState & { inAutolink?: boolean };

const markdownSerializer = new MarkdownSerializer(
  {
    blockquote(state, node) {
      state.wrapBlock("> ", null, node, () => state.renderContent(node));
    },
    codeBlock(state, node) {
      const language =
        typeof node.attrs.language === "string" && node.attrs.language.trim().length > 0
          ? node.attrs.language.trim()
          : typeof node.attrs.params === "string" && node.attrs.params.trim().length > 0
            ? node.attrs.params.trim()
            : "";
      const backticks = node.textContent.match(/`{3,}/gm);
      const fence = backticks ? `${backticks.sort().slice(-1)[0]}\`` : "```";

      state.write(`${fence}${language}\n`);
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
    heading(state, node) {
      state.write(`${state.repeat("#", node.attrs.level)} `);
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    horizontalRule(state, node) {
      state.write(node.attrs.markup || "---");
      state.closeBlock(node);
    },
    bulletList(state, node) {
      state.renderList(node, "  ", () => "* ");
    },
    orderedList(state, node) {
      const start = node.attrs.order || 1;
      const maxWidth = String(start + node.childCount - 1).length;
      const spacing = state.repeat(" ", maxWidth + 2);

      state.renderList(node, spacing, (index) => {
        const number = String(start + index);
        return `${state.repeat(" ", maxWidth - number.length)}${number}. `;
      });
    },
    listItem(state, node) {
      state.renderContent(node);
    },
    paragraph(state, node) {
      state.renderInline(node);
      state.closeBlock(node);
    },
    image(state, node) {
      const alt =
        typeof node.attrs.alt === "string" && node.attrs.alt.trim().length > 0
          ? node.attrs.alt
          : "";
      const title =
        typeof node.attrs.title === "string" && node.attrs.title.trim().length > 0
          ? node.attrs.title
          : null;
      const label = alt || title || "图片";

      state.write(`[图片] ${state.esc(label)}`);
    },
    hardBreak(state, node, parent, index) {
      for (let nextIndex = index + 1; nextIndex < parent.childCount; nextIndex += 1) {
        if (parent.child(nextIndex).type !== node.type) {
          state.write("\\\n");
          return;
        }
      }
    },
    text(state, node) {
      state.text(node.text || "", !(state as MarkdownStateWithAutolink).inAutolink);
    },
    taskList(state, node) {
      state.renderList(node, "  ", (index) => {
        const item = node.child(index);
        return item.attrs.checked ? "- [x] " : "- [ ] ";
      });
    },
    taskItem(state, node) {
      state.renderContent(node);
    },
    table(state, node) {
      const rows: string[] = [];
      let headerWidth = 0;

      node.forEach((row, _, rowIndex) => {
        const cells: string[] = [];
        row.forEach((cell) => {
          const raw = cell.textContent.replace(/\s+/g, " ").trim();
          cells.push(raw.replace(/\|/g, "\\|"));
        });
        headerWidth = Math.max(headerWidth, cells.length);
        rows.push(`| ${cells.join(" | ")} |`);
        if (rowIndex === 0) {
          rows.push(`| ${new Array(Math.max(cells.length, 1)).fill("---").join(" | ")} |`);
        }
      });

      if (rows.length === 0) {
        const width = Math.max(headerWidth, 1);
        rows.push(`| ${new Array(width).fill(" ").join(" | ")} |`);
        rows.push(`| ${new Array(width).fill("---").join(" | ")} |`);
      }

      state.write(rows.join("\n"));
      state.closeBlock(node);
    },
    attachment(state, node) {
      const title =
        typeof node.attrs.title === "string" && node.attrs.title.trim().length > 0
          ? node.attrs.title
          : "未命名文件";
      state.write(`[附件] ${state.esc(title)}`);
      state.closeBlock(node);
    },
    internalReference(state, node) {
      state.write(
        buildInternalReferenceToken({
          refKind:
            node.attrs.refKind === "conclusion" ||
            node.attrs.refKind === "todo" ||
            node.attrs.refKind === "document"
              ? node.attrs.refKind
              : "note",
          refId: Number(node.attrs.refId) || 0,
          label:
            typeof node.attrs.label === "string" && node.attrs.label.trim().length > 0
              ? node.attrs.label
              : "未命名引用",
        }),
      );
    },
  },
  {
    italic: {
      open: "*",
      close: "*",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    bold: {
      open: "**",
      close: "**",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    link: {
      open(state, mark, parent, index) {
        const nextState = state as MarkdownStateWithAutolink;
        nextState.inAutolink = isPlainUrl(mark, parent, index);
        return nextState.inAutolink ? "<" : "[";
      },
      close(state, mark) {
        const nextState = state as MarkdownStateWithAutolink;
        const { inAutolink } = nextState;
        nextState.inAutolink = undefined;
        return inAutolink
          ? ">"
          : `](${mark.attrs.href.replace(/[\(\)"]/g, "\\$&")}${mark.attrs.title ? ` "${mark.attrs.title.replace(/"/g, '\\"')}"` : ""})`;
      },
      mixable: true,
    },
    code: {
      open(_state, _mark, parent, index) {
        return backticksFor(parent.child(index), -1);
      },
      close(_state, _mark, parent, index) {
        return backticksFor(parent.child(index - 1), 1);
      },
      escape: false,
    },
    strike: {
      open: "~~",
      close: "~~",
      mixable: true,
      expelEnclosingWhitespace: true,
    },
    underline: {
      open: "",
      close: "",
      mixable: true,
    },
    highlight: {
      open: "",
      close: "",
      mixable: true,
    },
  },
  {
    strict: false,
  },
);

export function serializeEditorMarkdown(editor: Editor) {
  return markdownSerializer.serialize(editor.state.doc).trim();
}

function backticksFor(node: ProseMirrorNode, side: number) {
  const ticks = /`+/g;
  let match: RegExpExecArray | null = null;
  let length = 0;

  if (node.isText) {
    while ((match = ticks.exec(node.text || ""))) {
      length = Math.max(length, match[0].length);
    }
  }

  let result = length > 0 && side > 0 ? " `" : "`";
  for (let index = 0; index < length; index += 1) {
    result += "`";
  }
  if (length > 0 && side < 0) {
    result += " ";
  }
  return result;
}

function isPlainUrl(link: Mark, parent: ProseMirrorNode, index: number) {
  if (link.attrs.title || !/^\w+:/.test(link.attrs.href)) {
    return false;
  }

  const content = parent.child(index);
  if (
    !content.isText ||
    content.text !== link.attrs.href ||
    content.marks[content.marks.length - 1] !== link
  ) {
    return false;
  }

  return index === parent.childCount - 1 || !link.isInSet(parent.child(index + 1).marks);
}
