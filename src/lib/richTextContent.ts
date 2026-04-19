import { defaultMarkdownParser } from "@tiptap/pm/markdown";
import {
  buildInternalReferenceHtml,
  splitInternalReferenceText,
} from "./internalReferences";
import { repairRichTextAssetHtml } from "./richTextAssets";

export const EMPTY_RICH_TEXT_HTML = "<p></p>";

const HTML_TAG_PATTERN = /<[^>]+>/;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;
const LIST_INDENT = "  ";
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

interface RichTextPlainTextOptions {
  preserveStructure?: boolean;
}

export function renderMarkdownToHtml(markdown?: string | null) {
  const normalized = markdown?.trim();

  if (!normalized) {
    return EMPTY_RICH_TEXT_HTML;
  }

  const normalizedWithReferences = replaceInternalReferenceTokensWithHtml(normalized);
  const rendered = containsMarkdownTable(normalizedWithReferences)
    ? renderMarkdownWithTables(normalizedWithReferences)
    : defaultMarkdownParser.tokenizer.render(normalizedWithReferences).trim();

  return rendered.length > 0 ? rendered : EMPTY_RICH_TEXT_HTML;
}

export function getRenderableRichTextHtml(content: {
  html?: string | null;
  markdown?: string | null;
}) {
  const normalizedHtml = content.html?.trim() || "";
  const normalizedMarkdown = content.markdown?.trim() || "";

  if (!normalizedHtml) {
    return normalizedMarkdown ? renderMarkdownToHtml(normalizedMarkdown) : EMPTY_RICH_TEXT_HTML;
  }

  if (HTML_TAG_PATTERN.test(normalizedHtml)) {
    return repairRichTextAssetHtml(normalizedHtml) || EMPTY_RICH_TEXT_HTML;
  }

  return normalizedMarkdown
    ? renderMarkdownToHtml(normalizedMarkdown)
    : renderMarkdownToHtml(normalizedHtml);
}

export function getEditableRichTextHtml(content: {
  html?: string | null;
  markdown?: string | null;
}) {
  const normalizedHtml = content.html?.trim() || "";
  const normalizedMarkdown = content.markdown?.trim() || "";

  if (normalizedHtml) {
    return repairRichTextAssetHtml(normalizedHtml) || EMPTY_RICH_TEXT_HTML;
  }

  return normalizedMarkdown ? renderMarkdownToHtml(normalizedMarkdown) : EMPTY_RICH_TEXT_HTML;
}

export function richTextHtmlToPlainText(
  html?: string | null,
  options: RichTextPlainTextOptions = {},
) {
  const normalized = html?.trim() || "";

  if (!normalized) {
    return "";
  }

  if (typeof DOMParser === "undefined") {
    return collapseWhitespace(normalized.replace(/<[^>]+>/g, " "));
  }

  const doc = new DOMParser().parseFromString(normalized, "text/html");
  const segments = Array.from(doc.body.childNodes)
    .map((node) =>
      options.preserveStructure ? extractStructuredNodeText(node, { indent: 0 }) : extractNodeText(node),
    )
    .filter((segment) => segment.length > 0);

  if (options.preserveStructure) {
    return normalizeStructuredText(joinStructuredSegments(segments));
  }

  return collapseWhitespace(segments.join(" "));
}

function replaceInternalReferenceTokensWithHtml(markdown: string) {
  return splitInternalReferenceText(markdown)
    .map((segment) =>
      segment.type === "text" ? segment.text : buildInternalReferenceHtml(segment.reference),
    )
    .join("");
}

function containsMarkdownTable(markdown: string) {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (isMarkdownTableStart(lines, index)) {
      return true;
    }
  }

  return false;
}

function renderMarkdownWithTables(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const renderedSegments: string[] = [];
  let markdownBuffer: string[] = [];
  let index = 0;

  const flushMarkdownBuffer = () => {
    const source = markdownBuffer.join("\n").trim();

    markdownBuffer = [];

    if (!source) {
      return;
    }

    const rendered = defaultMarkdownParser.tokenizer.render(source).trim();

    if (rendered.length > 0) {
      renderedSegments.push(rendered);
    }
  };

  while (index < lines.length) {
    if (isMarkdownTableStart(lines, index)) {
      flushMarkdownBuffer();

      const { html, nextIndex } = renderMarkdownTable(lines, index);
      renderedSegments.push(html);
      index = nextIndex;
      continue;
    }

    markdownBuffer.push(lines[index]);
    index += 1;
  }

  flushMarkdownBuffer();

  return renderedSegments.join("");
}

function isMarkdownTableStart(lines: string[], index: number) {
  if (index >= lines.length - 1) {
    return false;
  }

  const headerCells = parseMarkdownTableRow(lines[index]);
  const separator = parseMarkdownTableSeparator(lines[index + 1]);

  return headerCells.length > 0 && separator.length === headerCells.length;
}

function renderMarkdownTable(lines: string[], startIndex: number) {
  const headerCells = parseMarkdownTableRow(lines[startIndex]);
  const alignments = parseMarkdownTableSeparator(lines[startIndex + 1]);
  const bodyRows: string[][] = [];

  let index = startIndex + 2;

  while (index < lines.length) {
    const cells = parseMarkdownTableRow(lines[index]);

    if (cells.length !== headerCells.length) {
      break;
    }

    bodyRows.push(cells);
    index += 1;
  }

  const headerHtml = `<thead><tr>${headerCells
    .map((cell, cellIndex) => renderTableCell("th", cell, alignments[cellIndex]))
    .join("")}</tr></thead>`;
  const bodyHtml = bodyRows.length
    ? `<tbody>${bodyRows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, cellIndex) => renderTableCell("td", cell, alignments[cellIndex]))
              .join("")}</tr>`,
        )
        .join("")}</tbody>`
    : "";

  return {
    html: `<table>${headerHtml}${bodyHtml}</table>`,
    nextIndex: index,
  };
}

function renderTableCell(
  tagName: "td" | "th",
  cellContent: string,
  alignment: "left" | "center" | "right" | null,
) {
  const rendered = cellContent
    ? defaultMarkdownParser.tokenizer.renderInline(cellContent).trim()
    : "";
  const alignStyle = alignment ? ` style="text-align:${alignment}"` : "";

  return `<${tagName}${alignStyle}>${rendered}</${tagName}>`;
}

function parseMarkdownTableSeparator(line: string) {
  const cells = parseMarkdownTableRow(line);

  if (cells.length === 0 || cells.some((cell) => !TABLE_SEPARATOR_CELL_PATTERN.test(cell))) {
    return [] as Array<"left" | "center" | "right" | null>;
  }

  return cells.map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) {
      return "center";
    }

    if (cell.endsWith(":")) {
      return "right";
    }

    if (cell.startsWith(":")) {
      return "left";
    }

    return null;
  });
}

function parseMarkdownTableRow(line: string) {
  const normalized = line.trim();

  if (!normalized.includes("|")) {
    return [] as string[];
  }

  const strippedStart = normalized.startsWith("|") ? normalized.slice(1) : normalized;
  const stripped = strippedStart.endsWith("|")
    ? strippedStart.slice(0, Math.max(strippedStart.length - 1, 0))
    : strippedStart;
  const cells = stripped
    .split(/(?<!\\)\|/g)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());

  return cells.some((cell) => cell.length > 0) ? cells : [];
}

function extractNodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return collapseWhitespace(node.textContent ?? "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as HTMLElement;

  if (element.tagName === "TABLE") {
    const rows = Array.from(element.querySelectorAll("tr"))
      .map((row) =>
        Array.from(row.querySelectorAll("th, td"))
          .map((cell) => collapseWhitespace(cell.textContent ?? ""))
          .filter((cell) => cell.length > 0)
          .join(" | "),
      )
      .filter((row) => row.length > 0);

    return rows.join(" / ");
  }

  if (element.dataset.type === "attachment") {
    return collapseWhitespace(element.dataset.title || element.textContent || "");
  }

  return collapseWhitespace(
    Array.from(element.childNodes)
      .map((child) => extractNodeText(child))
      .filter((segment) => segment.length > 0)
      .join(" "),
  );
}

function extractStructuredNodeText(node: Node, context: { indent: number }): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeInlineBlockText(node.textContent ?? "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as HTMLElement;
  const tagName = element.tagName;

  if (tagName === "BR") {
    return "\n";
  }

  if (tagName === "TABLE") {
    return normalizeStructuredText(
      Array.from(element.querySelectorAll("tr"))
        .map((row) =>
          Array.from(row.querySelectorAll("th, td"))
            .map((cell) => collapseWhitespace(cell.textContent ?? ""))
            .filter((cell) => cell.length > 0)
            .join(" | "),
        )
        .filter((row) => row.length > 0)
        .join("\n"),
    );
  }

  if (tagName === "OL") {
    return extractListText(element, context, "ordered");
  }

  if (tagName === "UL") {
    return extractListText(
      element,
      context,
      element.dataset.type === "taskList" ? "task" : "bullet",
    );
  }

  if (element.dataset.type === "attachment") {
    return collapseWhitespace(element.dataset.title || element.textContent || "");
  }

  if (tagName === "IMG") {
    return collapseWhitespace(element.getAttribute("alt") || element.getAttribute("title") || "");
  }

  if (tagName === "PRE") {
    return normalizePreformattedText(element.textContent ?? "");
  }

  if (hasStructuredChildElements(element)) {
    return normalizeStructuredText(
      joinStructuredSegments(
        Array.from(element.childNodes)
          .map((child) => extractStructuredNodeText(child, context))
          .filter((segment) => segment.length > 0),
      ),
    );
  }

  return normalizeInlineBlockText(extractInlineText(element));
}

function extractInlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeInlineWhitespace(node.textContent ?? "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as HTMLElement;

  if (element.tagName === "BR") {
    return "\n";
  }

  if (element.dataset.type === "attachment") {
    return collapseWhitespace(element.dataset.title || element.textContent || "");
  }

  if (element.tagName === "IMG") {
    return collapseWhitespace(element.getAttribute("alt") || element.getAttribute("title") || "");
  }

  return Array.from(element.childNodes)
    .map((child) => extractInlineText(child))
    .join("");
}

function extractListText(
  element: HTMLElement,
  context: { indent: number },
  listType: "ordered" | "bullet" | "task",
) {
  const items = Array.from(element.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.tagName === "LI",
  );
  const start = parseListStart(element);

  return normalizeStructuredText(
    joinStructuredSegments(
      items
        .map((item, index) => extractListItemText(item, context, listType, start + index))
        .filter((segment) => segment.length > 0),
    ),
  );
}

function extractListItemText(
  item: HTMLElement,
  context: { indent: number },
  listType: "ordered" | "bullet" | "task",
  orderIndex: number,
) {
  const sections = Array.from(item.childNodes).reduce(
    (accumulator, child) => {
      const next = extractListItemSections(child, context);

      accumulator.bodySegments.push(...next.bodySegments);
      accumulator.nestedSegments.push(...next.nestedSegments);
      return accumulator;
    },
    { bodySegments: [] as string[], nestedSegments: [] as string[] },
  );
  const bodyText = normalizeStructuredText(joinStructuredSegments(sections.bodySegments));
  const nestedText = normalizeStructuredText(joinStructuredSegments(sections.nestedSegments));
  const marker = buildListItemMarker(item, listType, orderIndex);
  const firstLinePrefix = `${LIST_INDENT.repeat(context.indent)}${marker}`;
  const continuationPrefix = `${LIST_INDENT.repeat(context.indent)}${" ".repeat(marker.length)}`;
  const prefixedBody = applyListItemPrefix(bodyText, firstLinePrefix, continuationPrefix);

  return normalizeStructuredText(
    joinStructuredSegments([prefixedBody, nestedText].filter((segment) => segment.length > 0)),
  );
}

function extractListItemSections(node: Node, context: { indent: number }) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeInlineBlockText(node.textContent ?? "");

    return {
      bodySegments: text ? [text] : [],
      nestedSegments: [] as string[],
    };
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return {
      bodySegments: [] as string[],
      nestedSegments: [] as string[],
    };
  }

  const element = node as HTMLElement;
  const tagName = element.tagName;

  if (tagName === "OL" || tagName === "UL") {
    return {
      bodySegments: [] as string[],
      nestedSegments: [
        extractStructuredNodeText(element, {
          indent: context.indent + 1,
        }),
      ].filter((segment) => segment.length > 0),
    };
  }

  if (tagName === "BR") {
    return {
      bodySegments: ["\n"],
      nestedSegments: [] as string[],
    };
  }

  if (!hasStructuredChildElements(element)) {
    const text = normalizeInlineBlockText(extractInlineText(element));

    return {
      bodySegments: text ? [text] : [],
      nestedSegments: [] as string[],
    };
  }

  return Array.from(element.childNodes).reduce(
    (accumulator, child) => {
      const next = extractListItemSections(child, context);

      accumulator.bodySegments.push(...next.bodySegments);
      accumulator.nestedSegments.push(...next.nestedSegments);
      return accumulator;
    },
    { bodySegments: [] as string[], nestedSegments: [] as string[] },
  );
}

function buildListItemMarker(
  item: HTMLElement,
  listType: "ordered" | "bullet" | "task",
  orderIndex: number,
) {
  if (listType === "ordered") {
    return `${orderIndex}. `;
  }

  if (listType === "task") {
    return item.dataset.checked === "true" ? "[x] " : "[ ] ";
  }

  return "- ";
}

function applyListItemPrefix(bodyText: string, firstLinePrefix: string, continuationPrefix: string) {
  if (!bodyText) {
    return firstLinePrefix.trimEnd();
  }

  return bodyText
    .split("\n")
    .map((line, index) => `${index === 0 ? firstLinePrefix : continuationPrefix}${line}`)
    .join("\n");
}

function parseListStart(element: HTMLElement) {
  const rawStart = element.getAttribute("start");
  const parsedStart = Number.parseInt(rawStart ?? "", 10);

  return Number.isFinite(parsedStart) ? parsedStart : 1;
}

function hasStructuredChildElements(element: HTMLElement) {
  return Array.from(element.childNodes).some(
    (child) => child instanceof HTMLElement && (child.tagName === "BR" || isBlockElement(child)),
  );
}

function isBlockElement(element: HTMLElement) {
  return BLOCK_TAGS.has(element.tagName);
}

function normalizeInlineWhitespace(source: string) {
  return source
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n+ */g, "\n");
}

function normalizeInlineBlockText(source: string) {
  return normalizeStructuredText(
    normalizeInlineWhitespace(source)
      .split("\n")
      .map((line) => collapseWhitespace(line))
      .join("\n"),
  );
}

function normalizePreformattedText(source: string) {
  return source.replace(/\r/g, "").trim();
}

function normalizeStructuredText(source: string) {
  const normalizedLines = source
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => {
      const leadingWhitespace = /^\s*/.exec(line)?.[0] ?? "";
      const content = line
        .slice(leadingWhitespace.length)
        .replace(/[^\S\n]+/g, " ")
        .trimEnd();

      return `${leadingWhitespace}${content}`;
    });
  const trimmedLines = [...normalizedLines];

  while (trimmedLines[0]?.trim().length === 0) {
    trimmedLines.shift();
  }

  while (trimmedLines[trimmedLines.length - 1]?.trim().length === 0) {
    trimmedLines.pop();
  }

  return trimmedLines.reduce((accumulator, line) => {
    if (line.length === 0 && accumulator[accumulator.length - 1] === "") {
      return accumulator;
    }

    accumulator.push(line);
    return accumulator;
  }, [] as string[]).join("\n");
}

function joinStructuredSegments(segments: string[]) {
  return segments.reduce((result, segment) => {
    if (!segment) {
      return result;
    }

    if (!result) {
      return segment;
    }

    return result.endsWith("\n") || segment.startsWith("\n")
      ? `${result}${segment}`
      : `${result}\n${segment}`;
  }, "");
}

function collapseWhitespace(source: string) {
  return source.replace(/\s+/g, " ").trim();
}
