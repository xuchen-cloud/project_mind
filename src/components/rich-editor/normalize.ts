import { EMPTY_RICH_EDITOR_HTML } from "./markdown";
import type { RichEditorValue } from "./types";

const BLANK_TEXT_PATTERN = /^[\s\u00a0]*$/u;
const LEADING_BOUNDARY_SPACE_PATTERN = /^[\s\u00a0]+/u;
const TRAILING_BOUNDARY_SPACE_PATTERN = /[\s\u00a0]+$/u;
const MEANINGFUL_VOID_TAGS = new Set(["AUDIO", "HR", "IFRAME", "IMG", "SVG", "TABLE", "VIDEO"]);
const PROTECTED_TRIM_TAGS = new Set(["CODE", "PRE"]);

type BoundarySide = "start" | "end";

export function normalizeRichEditorValue(value: RichEditorValue): RichEditorValue {
  return {
    html: normalizeRichEditorHtml(value.html),
    text: trimBoundaryPlainText(value.text),
    markdown: trimBoundaryPlainText(value.markdown),
  };
}

export function normalizeRichEditorHtml(html?: string | null) {
  const normalized = html ?? "";

  if (!normalized) {
    return EMPTY_RICH_EDITOR_HTML;
  }

  if (typeof DOMParser === "undefined") {
    return normalized.length > 0 ? normalized : EMPTY_RICH_EDITOR_HTML;
  }

  const doc = new DOMParser().parseFromString(normalized, "text/html");
  trimDocumentBoundaryWhitespace(doc.body);

  const serialized = doc.body.innerHTML;
  return serialized.length > 0 ? serialized : EMPTY_RICH_EDITOR_HTML;
}

function trimDocumentBoundaryWhitespace(root: HTMLElement) {
  let changed = true;

  while (changed) {
    changed = false;

    while (removeBlankBoundaryNode(root, "start")) {
      changed = true;
    }

    while (removeBlankBoundaryNode(root, "end")) {
      changed = true;
    }

    if (trimBoundaryTextNode(root, "start")) {
      changed = true;
    }

    if (trimBoundaryTextNode(root, "end")) {
      changed = true;
    }

    while (removeBlankBoundaryNode(root, "start")) {
      changed = true;
    }

    while (removeBlankBoundaryNode(root, "end")) {
      changed = true;
    }
  }
}

function removeBlankBoundaryNode(root: HTMLElement, side: BoundarySide) {
  const candidate = side === "start" ? root.firstChild : root.lastChild;

  if (!candidate || !isBlankBoundaryNode(candidate)) {
    return false;
  }

  candidate.remove();
  return true;
}

function trimBoundaryTextNode(root: HTMLElement, side: BoundarySide) {
  const target = findBoundaryTextNode(root, side);

  if (!target) {
    return false;
  }

  const nextValue =
    side === "start"
      ? target.data.replace(LEADING_BOUNDARY_SPACE_PATTERN, "")
      : target.data.replace(TRAILING_BOUNDARY_SPACE_PATTERN, "");

  if (nextValue === target.data) {
    return false;
  }

  target.data = nextValue;
  return true;
}

function findBoundaryTextNode(root: ParentNode, side: BoundarySide): Text | null {
  const children = Array.from(root.childNodes);
  const orderedChildren = side === "start" ? children : children.reverse();

  for (const child of orderedChildren) {
    if (child.nodeType === Node.TEXT_NODE) {
      return child as Text;
    }

    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }

    const element = child as Element;

    if (isProtectedTrimElement(element) || isMeaningfulBoundaryElement(element)) {
      return null;
    }

    const nested = findBoundaryTextNode(element, side);

    if (nested) {
      return nested;
    }

    if (!isBlankBoundaryNode(element)) {
      return null;
    }
  }

  return null;
}

function isBlankBoundaryNode(node: ChildNode): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    return BLANK_TEXT_PATTERN.test(node.textContent ?? "");
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return true;
  }

  const element = node as Element;

  if (element.tagName === "BR") {
    return true;
  }

  if (isMeaningfulBoundaryElement(element)) {
    return false;
  }

  return Array.from(element.childNodes).every((child) => isBlankBoundaryNode(child));
}

function isMeaningfulBoundaryElement(element: Element) {
  if (MEANINGFUL_VOID_TAGS.has(element.tagName)) {
    return true;
  }

  return element instanceof HTMLElement && element.dataset.type === "attachment";
}

function isProtectedTrimElement(element: Element) {
  return PROTECTED_TRIM_TAGS.has(element.tagName);
}

function trimBoundaryPlainText(value: string) {
  return value
    .replace(LEADING_BOUNDARY_SPACE_PATTERN, "")
    .replace(TRAILING_BOUNDARY_SPACE_PATTERN, "");
}
