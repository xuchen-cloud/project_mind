import { defaultMarkdownParser } from "@tiptap/pm/markdown";

export const EMPTY_RICH_TEXT_HTML = "<p></p>";

const HTML_TAG_PATTERN = /<[^>]+>/;
const TABLE_SEPARATOR_CELL_PATTERN = /^:?-{3,}:?$/;

export function renderMarkdownToHtml(markdown?: string | null) {
  const normalized = markdown?.trim();

  if (!normalized) {
    return EMPTY_RICH_TEXT_HTML;
  }

  const rendered = containsMarkdownTable(normalized)
    ? renderMarkdownWithTables(normalized)
    : defaultMarkdownParser.tokenizer.render(normalized).trim();

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
    return normalizedHtml;
  }

  return normalizedMarkdown
    ? renderMarkdownToHtml(normalizedMarkdown)
    : renderMarkdownToHtml(normalizedHtml);
}

export function richTextHtmlToPlainText(html?: string | null) {
  const normalized = html?.trim() || "";

  if (!normalized) {
    return "";
  }

  if (typeof DOMParser === "undefined") {
    return collapseWhitespace(normalized.replace(/<[^>]+>/g, " "));
  }

  const doc = new DOMParser().parseFromString(normalized, "text/html");
  const segments = Array.from(doc.body.childNodes)
    .map((node) => extractNodeText(node))
    .filter((segment) => segment.length > 0);

  return collapseWhitespace(segments.join(" "));
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

function collapseWhitespace(source: string) {
  return source.replace(/\s+/g, " ").trim();
}
