import type { Editor } from "@tiptap/core";
import {
  DOMParser as ProseMirrorDomParser,
  DOMSerializer,
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from "@tiptap/pm/model";

import { richTextHtmlToPlainText } from "../../lib/richTextContent";
import { renderMarkdownToHtml, serializeRichTextNodesMarkdown } from "./markdown";

export interface EditorRewritePlaceholder {
  token: string;
  label: string;
  node: ProseMirrorNode;
}

export interface EditorRewriteSelectionPayload {
  from: number;
  to: number;
  selectedText: string;
  selectedHtml: string;
  expandedMarkdown: string;
  placeholders: EditorRewritePlaceholder[];
  blockRanges: EditorRewriteBlockRange[];
}

export interface EditorRewriteBlockRange {
  from: number;
  to: number;
  isPlaceholder: boolean;
}

export interface EditorRewriteDiffRow {
  kind: "same" | "added" | "removed";
  text: string;
  placeholderLabel?: string;
}

const BLOCK_PLACEHOLDER_PREFIX = "PM_BLOCK_TOKEN_";

export function buildEditorRewriteSelection(editor: Editor): EditorRewriteSelectionPayload | null {
  const selection = editor.state.selection;
  if (selection.empty) {
    return null;
  }

  const blocks = collectSelectedTopLevelBlocks(editor, selection.from, selection.to);
  if (blocks.length === 0) {
    return null;
  }

  const placeholders: EditorRewritePlaceholder[] = [];
  const blockRanges: EditorRewriteBlockRange[] = [];
  const segments = blocks.map(({ node }, index) => {
    blockRanges.push({
      from: blocks[index].from,
      to: blocks[index].to,
      isPlaceholder: isPlaceholderBlock(node),
    });
    if (!isPlaceholderBlock(node)) {
      return serializeRichTextNodesMarkdown(editor, [node]);
    }

    const token = `${BLOCK_PLACEHOLDER_PREFIX}${index + 1}`;
    placeholders.push({
      token,
      label: describePlaceholderNode(node),
      node,
    });
    return token;
  });

  return {
    from: blocks[0].from,
    to: blocks[blocks.length - 1].to,
    selectedText: serializeSelectionPlainText(editor),
    selectedHtml: serializeSelectedBlocksHtml(editor, blocks.map((block) => block.node)),
    expandedMarkdown: segments.filter((segment) => segment.trim().length > 0).join("\n\n"),
    placeholders,
    blockRanges,
  };
}

function serializeSelectedBlocksHtml(editor: Editor, nodes: readonly ProseMirrorNode[]) {
  if (typeof document === "undefined" || nodes.length === 0) {
    return "";
  }

  const serializer = DOMSerializer.fromSchema(editor.state.schema);
  const container = document.createElement("div");
  container.appendChild(serializer.serializeFragment(Fragment.fromArray([...nodes]), { document }));
  return container.innerHTML;
}

export function buildEditorRewriteSlice(
  editor: Editor,
  markdown: string,
  placeholders: readonly EditorRewritePlaceholder[],
): Slice {
  const nodes = explodeMarkdownToNodes(editor, markdown, placeholders);
  return new Slice(Fragment.fromArray(nodes), 0, 0);
}

export function buildEditorRewritePreviewHtml(
  editor: Editor,
  markdown: string,
  placeholders: readonly EditorRewritePlaceholder[],
) {
  const nodes = explodeMarkdownToNodes(editor, markdown, placeholders);
  if (nodes.length === 0) {
    return "";
  }

  const serializer = DOMSerializer.fromSchema(editor.state.schema);
  const container = document.createElement("div");
  container.appendChild(serializer.serializeFragment(Fragment.fromArray(nodes), { document }));
  return container.innerHTML;
}

export function buildEditorRewriteDiffRows(
  originalMarkdown: string,
  rewrittenMarkdown: string,
  placeholders: readonly EditorRewritePlaceholder[],
): EditorRewriteDiffRow[] {
  const placeholderLabels = new Map(placeholders.map((item) => [item.token, item.label]));
  const originalLines = splitDiffLines(originalMarkdown);
  const rewrittenLines = splitDiffLines(rewrittenMarkdown);
  const rows: EditorRewriteDiffRow[] = [];

  const dp = Array.from({ length: originalLines.length + 1 }, () =>
    new Array<number>(rewrittenLines.length + 1).fill(0),
  );

  for (let left = originalLines.length - 1; left >= 0; left -= 1) {
    for (let right = rewrittenLines.length - 1; right >= 0; right -= 1) {
      dp[left][right] =
        originalLines[left] === rewrittenLines[right]
          ? dp[left + 1][right + 1] + 1
          : Math.max(dp[left + 1][right], dp[left][right + 1]);
    }
  }

  let left = 0;
  let right = 0;
  while (left < originalLines.length && right < rewrittenLines.length) {
    if (originalLines[left] === rewrittenLines[right]) {
      rows.push(asDiffRow("same", originalLines[left], placeholderLabels));
      left += 1;
      right += 1;
      continue;
    }

    if (dp[left + 1][right] >= dp[left][right + 1]) {
      rows.push(asDiffRow("removed", originalLines[left], placeholderLabels));
      left += 1;
      continue;
    }

    rows.push(asDiffRow("added", rewrittenLines[right], placeholderLabels));
    right += 1;
  }

  while (left < originalLines.length) {
    rows.push(asDiffRow("removed", originalLines[left], placeholderLabels));
    left += 1;
  }
  while (right < rewrittenLines.length) {
    rows.push(asDiffRow("added", rewrittenLines[right], placeholderLabels));
    right += 1;
  }

  return rows.length > 0 ? rows : [asDiffRow("same", "", placeholderLabels)];
}

function collectSelectedTopLevelBlocks(editor: Editor, from: number, to: number) {
  const blocks: Array<{ node: ProseMirrorNode; from: number; to: number }> = [];

  editor.state.doc.forEach((node, offset) => {
    const contentFrom = offset + 1;
    const contentTo = contentFrom + node.nodeSize - 1;
    if (contentTo <= from || contentFrom >= to) {
      return;
    }

    blocks.push({ node, from: offset, to: offset + node.nodeSize });
  });

  return blocks;
}

function serializeSelectionPlainText(editor: Editor) {
  if (typeof document === "undefined") {
    return editor.state.selection.content().content.textBetween(0, editor.state.selection.content().content.size, "\n");
  }

  const serializer = DOMSerializer.fromSchema(editor.state.schema);
  const container = document.createElement("div");
  container.appendChild(
    serializer.serializeFragment(editor.state.selection.content().content, { document }),
  );
  return richTextHtmlToPlainText(container.innerHTML, { preserveStructure: true });
}

function isPlaceholderBlock(node: ProseMirrorNode) {
  return node.type.name === "image" || node.type.name === "attachment" || node.type.name === "table";
}

function describePlaceholderNode(node: ProseMirrorNode) {
  switch (node.type.name) {
    case "image":
      return "图片块";
    case "attachment":
      return "附件块";
    case "table":
      return "表格块";
    default:
      return "保留块";
  }
}

function explodeMarkdownToNodes(
  editor: Editor,
  markdown: string,
  placeholders: readonly EditorRewritePlaceholder[],
) {
  if (placeholders.length === 0) {
    return parseMarkdownSegmentNodes(editor, markdown);
  }

  const tokenPattern = new RegExp(
    `(${placeholders.map((item) => escapeRegExp(item.token)).join("|")})`,
    "g",
  );
  const placeholderMap = new Map(placeholders.map((item) => [item.token, item.node]));
  const nodes: ProseMirrorNode[] = [];

  for (const part of markdown.split(tokenPattern)) {
    if (!part) {
      continue;
    }

    const placeholderNode = placeholderMap.get(part);
    if (placeholderNode) {
      nodes.push(placeholderNode);
      continue;
    }

    nodes.push(...parseMarkdownSegmentNodes(editor, part));
  }

  return nodes;
}

function parseMarkdownSegmentNodes(editor: Editor, markdown: string) {
  const normalized = markdown.trim();
  if (!normalized) {
    return [] as ProseMirrorNode[];
  }

  const html = renderMarkdownToHtml(normalized);
  const container = document.createElement("div");
  container.innerHTML = html;
  const parsed = ProseMirrorDomParser.fromSchema(editor.state.schema).parse(container);
  const nodes: ProseMirrorNode[] = [];
  parsed.content.forEach((node) => nodes.push(node));
  return nodes;
}

function splitDiffLines(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  return lines.length > 0 ? lines : [""];
}

function asDiffRow(
  kind: EditorRewriteDiffRow["kind"],
  text: string,
  placeholderLabels: Map<string, string>,
): EditorRewriteDiffRow {
  const placeholderLabel = placeholderLabels.get(text.trim());
  return {
    kind,
    text,
    placeholderLabel,
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
