import type { AgentSourceRef } from "./agent-types";
import type {
  InternalReferenceKind,
  InternalReferenceResolveResult,
  InternalReferenceSearchResult,
} from "./types";

export interface InternalReferenceTarget {
  refKind: InternalReferenceKind;
  refId: number;
  label: string;
  sourceRef?: AgentSourceRef;
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
  "workspace_record",
  "todo",
  "document",
]);
const INTERNAL_REFERENCE_TOKEN_PATTERN =
  /\[\[(note|workspace_record|todo|document):(\d+)\|([^[\]\r\n]+?)\]\]/gu;
const INTERNAL_REFERENCE_EMBEDDED_TOKEN_PATTERN =
  /(?:\[\[(?:note|workspace_record|todo|document):\d+\|[^[\]\r\n]+?\]\])|(?:【【(?:note|workspace_record|todo|document):\d+\|[^【】\r\n]+?】】)/gu;
const INTERNAL_REFERENCE_SELECTOR = "[data-type='internal-reference']";

export function getInternalReferenceKindLabel(kind: InternalReferenceKind) {
  switch (kind) {
    case "note":
    case "workspace_record":
      return "记录";
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
      ...(reference.sourceRef ? { sourceRef: reference.sourceRef } : {}),
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
    normalized.sourceRef ? ` data-source-ref="${escapeHtml(JSON.stringify(normalized.sourceRef))}"` : "",
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
    ...(element.getAttribute("data-source-ref") ? { sourceRef: parseInternalReferenceSourceRef(element.getAttribute("data-source-ref")!) } : {}),
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

  if (refKind === "todo") {
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
    case "workspace_record":
      return "记录";
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

/** Fixed File evidence must never degrade into an ordinary current-file link. */
export function validateInternalReferenceSourceRef(value: unknown): AgentSourceRef {
  const fail = (): never => { throw new Error("无效的固定文件引用"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const source = value as AgentSourceRef;
  const object = source.object;
  if (!object || object.kind !== "file" || typeof object.workspaceId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(object.workspaceId)
    || typeof object.id !== "string" || !/^[1-9]\d*$/.test(object.id) || !Number.isSafeInteger(Number(object.id))
    || object.scope?.kind !== "project" || !Number.isSafeInteger(object.scope.projectId) || object.scope.projectId <= 0
    || typeof source.revision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(source.revision)
    || !Number.isSafeInteger(source.fileVersion) || source.fileVersion! <= 0 || source.fileVersion! > 4294967295
    || source.recordVersion !== null || source.blockId !== null
    || typeof source.title !== "string" || Array.from(source.title).length > 1000
    || typeof source.excerpt !== "string" || Array.from(source.excerpt).length > 2000) return fail();
  if (source.locator !== null) {
    const locator = source.locator;
    if (!locator || !["line", "paragraph", "page"].includes(locator.kind)
      || !("start" in locator) || !Number.isSafeInteger(locator.start) || locator.start < (locator.kind === "page" ? 0 : 1) || locator.start > 4294967295
      || !("end" in locator) || !Number.isSafeInteger(locator.end) || locator.end < locator.start || locator.end > 4294967295
      || (locator.kind === "page" && (!Number.isSafeInteger(locator.page) || locator.page <= 0 || locator.page > 4294967295))) return fail();
  }
  return source;
}
export function parseInternalReferenceSourceRef(json: string): AgentSourceRef {
  return validateInternalReferenceSourceRef(JSON.parse(json));
}

export type FixedFileLocatorView = {
  line?: number;
  page?: number;
  sourceLocator?: NonNullable<AgentSourceRef["locator"]>;
};

/** Map only coordinates understood by File preview. Extracted paragraph ordinals
 * have no reliable source-line mapping; preserve them for an explicit notice.
 * Page offsets are zero-based Unicode offsets, not lines or scroll positions.
 * Range/offset highlighting is owned by the preview consuming sourceLocator. */
export function resolveFixedFileLocator(source: AgentSourceRef): FixedFileLocatorView {
  const locator = source.locator;
  if (!locator) return {};
  return {
    ...(locator.kind === "line" ? { line: locator.start }
      : locator.kind === "page" ? { page: locator.page } : {}),
    sourceLocator: locator,
  };
}
