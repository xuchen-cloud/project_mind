import type { RichTextStyleSettings } from "../../lib/types";

export interface RecordExportSource {
  recordKind: "workspace" | "project";
  title?: string | null;
  projectName?: string | null;
  tags: string[];
  updatedAt?: string | null;
  committedHtml: string;
  style: RichTextStyleSettings;
}

export interface ExportInline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
}

export interface ExportListItem {
  blocks: ExportBlock[];
  checked?: boolean;
}

export type ExportBlock =
  | { type: "paragraph"; content: ExportInline[] }
  | { type: "heading"; level: 1 | 2 | 3; content: ExportInline[] }
  | { type: "bulletList" | "orderedList" | "taskList"; items: ExportListItem[] }
  | { type: "blockquote"; blocks: ExportBlock[] }
  | { type: "table"; rows: Array<{ cells: Array<{ header: boolean; blocks: ExportBlock[] }> }> }
  | { type: "codeBlock"; language?: string; code: string }
  | { type: "image"; id: string; source: string; path?: string; mimeType?: string; alt?: string; title?: string; widthPx?: number; annotationState?: string }
  | { type: "attachment"; title: string };

export interface RecordExportDocument {
  title?: string;
  projectName?: string;
  tags: string[];
  updatedAt?: string;
  style: RichTextStyleSettings;
  blocks: ExportBlock[];
}

export function projectRecordExportDocument(source: RecordExportSource): RecordExportDocument {
  const container = document.createElement("div");
  container.innerHTML = source.committedHtml;

  const blocks = Array.from(container.childNodes).flatMap(projectBlock);
  assignImageIds(blocks);
  return {
    title: nonEmpty(source.title),
    projectName: nonEmpty(source.projectName),
    tags: source.tags.map((tag) => tag.trim()).filter(Boolean),
    updatedAt: nonEmpty(source.updatedAt),
    style: source.style,
    blocks,
  };
}

function projectBlock(node: Node): ExportBlock[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent?.trim();
    return text ? [{ type: "paragraph", content: [{ text }] }] : [];
  }
  if (!(node instanceof HTMLElement)) return [];

  const tag = node.tagName.toLowerCase();
  if (tag === "p") return [{ type: "paragraph", content: projectInlineChildren(node) }];
  if (tag === "h1" || tag === "h2" || tag === "h3") {
    return [{
      type: "heading",
      level: Number(tag.slice(1)) as 1 | 2 | 3,
      content: projectInlineChildren(node),
    }];
  }
  if (tag === "ul" || tag === "ol") {
    const task = node.getAttribute("data-type") === "taskList";
    return [{
      type: task ? "taskList" : tag === "ol" ? "orderedList" : "bulletList",
      items: Array.from(node.children)
        .filter((child) => child.tagName.toLowerCase() === "li")
        .map((child) => ({
          blocks: Array.from(child.childNodes).flatMap(projectBlock),
          checked: task ? child.getAttribute("data-checked") === "true" : undefined,
        })),
    }];
  }
  if (tag === "blockquote") {
    return [{ type: "blockquote", blocks: Array.from(node.childNodes).flatMap(projectBlock) }];
  }
  if (tag === "table") {
    return [{
      type: "table",
      rows: Array.from(node.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr"))
        .map((row) => ({
          cells: Array.from(row.children)
            .filter((cell) => cell.matches("th, td"))
            .map((cell) => ({
              header: cell.tagName.toLowerCase() === "th",
              blocks: Array.from(cell.childNodes).flatMap(projectBlock),
            })),
        })),
    }];
  }
  if (tag === "pre") {
    const code = node.querySelector("code");
    const language = code?.className.match(/(?:^|\s)language-([^\s]+)/u)?.[1];
    return [{ type: "codeBlock", language, code: code?.textContent ?? node.textContent ?? "" }];
  }
  if (tag === "img") {
    return [{
      type: "image",
      id: "",
      source: node.getAttribute("src") ?? "",
      path: nonEmpty(node.getAttribute("data-path")),
      mimeType: nonEmpty(node.getAttribute("data-mime-type")),
      alt: nonEmpty(node.getAttribute("alt")),
      title: nonEmpty(node.getAttribute("title")),
      widthPx: positiveNumber(node.getAttribute("width") ?? node.style.width),
      annotationState: nonEmpty(node.getAttribute("data-annotation-state")),
    }];
  }
  if (node.getAttribute("data-type") === "attachment") {
    return [{ type: "attachment", title: nonEmpty(node.getAttribute("data-title")) ?? "未命名文件" }];
  }
  return Array.from(node.childNodes).flatMap(projectBlock);
}

function assignImageIds(blocks: ExportBlock[]) {
  let index = 0;
  const visit = (block: ExportBlock) => {
    if (block.type === "image") block.id = `image-${String(++index).padStart(3, "0")}`;
    else if (block.type === "blockquote") block.blocks.forEach(visit);
    else if (block.type === "bulletList" || block.type === "orderedList" || block.type === "taskList") {
      block.items.forEach((item) => item.blocks.forEach(visit));
    } else if (block.type === "table") {
      block.rows.forEach((row) => row.cells.forEach((cell) => cell.blocks.forEach(visit)));
    }
  };
  blocks.forEach(visit);
}

function projectInlineChildren(element: Element): ExportInline[] {
  return mergeAdjacentInlines(Array.from(element.childNodes).flatMap((node) => projectInline(node, {})));
}

function projectInline(node: Node, inherited: Omit<ExportInline, "text">): ExportInline[] {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ? [{ text: node.textContent, ...inherited }] : [];
  }
  if (!(node instanceof HTMLElement)) return [];

  const type = node.getAttribute("data-type");
  if (type === "internal-reference") {
    return [{ text: nonEmpty(node.getAttribute("data-label")) ?? "未命名引用", ...inherited }];
  }
  if (type === "contact-mention") {
    return [{ text: `@${nonEmpty(node.getAttribute("data-label")) ?? "未命名联系人"}`, ...inherited }];
  }
  if (type === "tag-mention") {
    return [{ text: `#${nonEmpty(node.getAttribute("data-label")) ?? "未命名标签"}`, ...inherited }];
  }
  if (node.tagName.toLowerCase() === "br") return [{ text: "\n", ...inherited }];

  const tag = node.tagName.toLowerCase();
  const marks = {
    ...inherited,
    bold: inherited.bold || tag === "strong" || tag === "b" || undefined,
    italic: inherited.italic || tag === "em" || tag === "i" || undefined,
    strike: inherited.strike || tag === "s" || tag === "del" || undefined,
    code: inherited.code || tag === "code" || undefined,
    href: tag === "a" ? safeExternalHref(node.getAttribute("href")) : inherited.href,
  };
  return Array.from(node.childNodes).flatMap((child) => projectInline(child, marks));
}

export function safeExternalHref(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function mergeAdjacentInlines(inlines: ExportInline[]) {
  return inlines.reduce<ExportInline[]>((result, inline) => {
    const previous = result[result.length - 1];
    if (previous && sameMarks(previous, inline)) previous.text += inline.text;
    else result.push({ ...inline });
    return result;
  }, []);
}

function sameMarks(left: ExportInline, right: ExportInline) {
  return left.bold === right.bold && left.italic === right.italic && left.strike === right.strike && left.code === right.code && left.href === right.href;
}

function nonEmpty(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function positiveNumber(value: string | null | undefined) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
