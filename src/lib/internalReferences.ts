import type {
  InternalReferenceKind,
  InternalReferenceResolveResult,
  InternalReferenceSearchResult,
} from "./types";

export interface InternalReferenceTarget {
  refKind: InternalReferenceKind;
  refId: number;
  label: string;
}

export type InternalReferenceTextSegment =
  | { type: "text"; text: string }
  | {
      type: "reference";
      token: string;
      key: string;
      reference: InternalReferenceTarget;
    };

export interface InternalReferenceTextTrigger {
  start: number;
  end: number;
  query: string;
}

const INTERNAL_REFERENCE_TRIGGER_TOKENS = ["[[", "【【"] as const;
const INTERNAL_REFERENCE_COMPACT_LABEL_MAX_CHARS = 15;

const INTERNAL_REFERENCE_KIND_SET = new Set<InternalReferenceKind>([
  "note",
  "conclusion",
  "todo",
  "document",
]);
const INTERNAL_REFERENCE_TOKEN_PATTERN =
  /\[\[(note|conclusion|todo|document):(\d+)\|([^[\]\r\n]+?)\]\]/gu;
const INTERNAL_REFERENCE_EMBEDDED_TOKEN_PATTERN =
  /(?:\[\[(?:note|conclusion|todo|document):\d+\|[^[\]\r\n]+?\]\])|(?:【【(?:note|conclusion|todo|document):\d+\|[^【】\r\n]+?】】)/gu;
const INTERNAL_REFERENCE_SELECTOR = "[data-type='internal-reference']";

export function getInternalReferenceKindLabel(kind: InternalReferenceKind) {
  switch (kind) {
    case "note":
      return "记录";
    case "conclusion":
      return "Record";
    case "todo":
      return "Todo";
    case "document":
      return "文件";
  }
}

export function buildInternalReferenceToken(reference: InternalReferenceTarget) {
  return `[[${reference.refKind}:${reference.refId}|${sanitizeInternalReferenceLabel(
    reference.label,
    reference.refKind,
  )}]]`;
}

export function buildInternalReferenceTarget(
  reference:
    | InternalReferenceTarget
    | Pick<InternalReferenceSearchResult, "kind" | "id" | "label">
    | Pick<InternalReferenceResolveResult, "kind" | "id" | "label">,
): InternalReferenceTarget {
  if ("refKind" in reference) {
    return {
      refKind: reference.refKind,
      refId: reference.refId,
      label: sanitizeInternalReferenceLabel(reference.label, reference.refKind),
    };
  }

  return {
    refKind: reference.kind,
    refId: reference.id,
    label: sanitizeInternalReferenceLabel(reference.label, reference.kind),
  };
}

export function splitInternalReferenceText(source: string): InternalReferenceTextSegment[] {
  const segments: InternalReferenceTextSegment[] = [];
  let lastIndex = 0;

  for (const match of source.matchAll(INTERNAL_REFERENCE_TOKEN_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    const kind = match[1] as InternalReferenceKind;
    const refId = Number(match[2]);
    const label = sanitizeInternalReferenceLabel(match[3], kind);

    if (index > lastIndex) {
      segments.push({
        type: "text",
        text: source.slice(lastIndex, index),
      });
    }

    segments.push({
      type: "reference",
      token,
      key: `${kind}:${refId}:${index}`,
      reference: {
        refKind: kind,
        refId,
        label,
      },
    });
    lastIndex = index + token.length;
  }

  if (lastIndex < source.length) {
    segments.push({
      type: "text",
      text: source.slice(lastIndex),
    });
  }

  return segments;
}

export function findInternalReferenceTextTrigger(
  source: string,
  caretPosition: number | null | undefined,
): InternalReferenceTextTrigger | null {
  if (
    typeof caretPosition !== "number" ||
    caretPosition < 0 ||
    caretPosition > source.length
  ) {
    return null;
  }

  const beforeCaret = source.slice(0, caretPosition);
  let start = -1;
  let triggerToken: (typeof INTERNAL_REFERENCE_TRIGGER_TOKENS)[number] | null = null;

  for (const token of INTERNAL_REFERENCE_TRIGGER_TOKENS) {
    const candidateStart = beforeCaret.lastIndexOf(token);

    if (candidateStart > start) {
      start = candidateStart;
      triggerToken = token;
    }
  }

  if (start < 0 || !triggerToken) {
    return null;
  }

  const query = beforeCaret.slice(start + triggerToken.length);

  if (
    query.includes("]]") ||
    query.includes("】】") ||
    query.includes("\n") ||
    query.includes("\r")
  ) {
    return null;
  }

  return {
    start,
    end: caretPosition,
    query,
  };
}

export function buildInternalReferenceHtml(reference: InternalReferenceTarget) {
  const normalized = buildInternalReferenceTarget(reference);
  const kindLabel = getInternalReferenceKindLabel(normalized.refKind);

  return [
    `<span data-type="internal-reference"`,
    ` data-ref-kind="${escapeHtml(normalized.refKind)}"`,
    ` data-ref-id="${normalized.refId}"`,
    ` data-label="${escapeHtml(normalized.label)}"`,
    ` class="internal-reference-chip"`,
    ` role="link"`,
    ` aria-label="${escapeHtml(`${kindLabel} ${normalized.label}`)}"`,
    ` contenteditable="false">`,
    `<span class="internal-reference-chip__kind">${escapeHtml(kindLabel)}</span>`,
    `<span class="internal-reference-chip__label">${escapeHtml(normalized.label)}</span>`,
    `</span>`,
  ].join("");
}

export function findInternalReferenceElement(target: EventTarget | null) {
  return target instanceof Element
    ? target.closest<HTMLElement>(INTERNAL_REFERENCE_SELECTOR)
    : null;
}

export function readInternalReferenceElement(
  element: HTMLElement | null | undefined,
): InternalReferenceTarget | null {
  if (!element) {
    return null;
  }

  const refKind = element.dataset.refKind;
  const refId = Number(element.dataset.refId);

  if (!isInternalReferenceKind(refKind) || !Number.isInteger(refId) || refId <= 0) {
    return null;
  }

  const label = sanitizeInternalReferenceLabel(element.dataset.label ?? "", refKind);

  return {
    refKind,
    refId,
    label,
  };
}

export function setInternalReferenceElementBroken(
  element: HTMLElement | null | undefined,
  broken: boolean,
) {
  element?.classList.toggle("is-broken", broken);
}

function sanitizeInternalReferenceLabel(label: string, refKind?: InternalReferenceKind) {
  const normalized = label
    .replace(INTERNAL_REFERENCE_EMBEDDED_TOKEN_PATTERN, " ")
    .replace(/[|\]]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  const fallback = getInternalReferenceFallbackLabel(refKind);
  const resolved = normalized || fallback;

  if (refKind === "todo" || refKind === "conclusion") {
    return truncateInternalReferenceLabel(
      resolved,
      INTERNAL_REFERENCE_COMPACT_LABEL_MAX_CHARS,
    );
  }

  return resolved;
}

function isInternalReferenceKind(value: unknown): value is InternalReferenceKind {
  return typeof value === "string" && INTERNAL_REFERENCE_KIND_SET.has(value as InternalReferenceKind);
}

function getInternalReferenceFallbackLabel(refKind?: InternalReferenceKind) {
  switch (refKind) {
    case "note":
      return "记录";
    case "conclusion":
      return "Record";
    case "todo":
      return "Todo";
    case "document":
      return "文件";
    default:
      return "未命名引用";
  }
}

function truncateInternalReferenceLabel(label: string, maxChars: number) {
  const characters = Array.from(label);
  if (characters.length <= maxChars) {
    return label;
  }
  return `${characters.slice(0, maxChars).join("")}...`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
