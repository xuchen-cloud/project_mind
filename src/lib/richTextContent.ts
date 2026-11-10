import MarkdownIt from "markdown-it";
import {
  buildInternalReferenceHtml,
  splitInternalReferenceText,
} from "./internalReferences";
import { buildContactMentionHtml, splitContactMentionText } from "./contactMentions";
import { repairRichTextAssetHtml } from "./richTextAssets";
import { buildTagMentionHtml, splitTagMentionText } from "./tagMentions";

export const EMPTY_RICH_TEXT_HTML = "<p></p>";

const HTML_TAG_PATTERN = /<[^>]+>/;
// A private renderer keeps CommonMark behavior and enables tables at any container depth.
const markdownRenderer = new MarkdownIt("commonmark", { html: false }).enable("table");
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

  const tokenized = replaceRichTextTokensWithPlaceholders(normalized);
  const rendered = markdownRenderer.render(tokenized.markdown).trim();

  const normalizedCodeBlocks = trimTrailingCodeBlockNewline(rendered);
  const restoredRichTextNodes = tokenized.replacements.reduce(
    (html, replacement) => html.replaceAll(replacement.placeholder, replacement.html),
    normalizedCodeBlocks,
  );

  return restoredRichTextNodes.length > 0 ? restoredRichTextNodes : EMPTY_RICH_TEXT_HTML;
}

export function trimTrailingCodeBlockNewline(html: string) {
  if (!html || typeof DOMParser === "undefined") {
    return html;
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  let changed = false;

  const trimElement = (element: Element) => {
    const text = element.textContent ?? "";
    const trimmed = text.replace(/(?:\r\n|\n|\r)$/u, "");

    if (trimmed === text) {
      return;
    }

    element.textContent = trimmed;
    changed = true;
  };

  doc.body.querySelectorAll("pre code").forEach(trimElement);
  doc.body.querySelectorAll("pre").forEach((element) => {
    if (element.querySelector("code")) {
      return;
    }

    trimElement(element);
  });

  return changed ? doc.body.innerHTML : html;
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

function replaceRichTextTokensWithPlaceholders(markdown: string) {
  const replacements: Array<{ placeholder: string; html: string }> = [];
  const stash = (html: string) => {
    const placeholder = `PMRICHTEXTTOKEN${replacements.length}END`;
    replacements.push({ placeholder, html });
    return placeholder;
  };

  const tokenizedMarkdown = splitInternalReferenceText(markdown)
    .map((segment) => {
      if (segment.type !== "text") {
        return stash(buildInternalReferenceHtml(segment.reference));
      }

      return splitContactMentionText(segment.text)
        .map((contactSegment) => {
          if (contactSegment.type === "mention") {
            return stash(buildContactMentionHtml(contactSegment.mention));
          }

          return splitTagMentionText(contactSegment.text)
            .map((tagSegment) =>
              tagSegment.type === "text" ? tagSegment.text : stash(buildTagMentionHtml(tagSegment.tag)),
            )
            .join("");
        })
        .join("");
    })
    .join("");

  return { markdown: tokenizedMarkdown, replacements };
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
