import { validateInternalReferenceSourceRef } from "./internalReferences";
import type { JSONContent } from "@tiptap/core";
import type { Schema, AttributeSpec } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import { positiveRecordObjectId } from "./record-object-ids";

export const RECORD_DOCUMENT_SCHEMA_VERSION = 1;
export const RECORD_BLOCK_TYPES = ["paragraph", "heading", "codeBlock", "blockquote",
  "bulletList", "orderedList", "listItem", "taskList", "taskItem", "table", "tableRow",
  "tableCell", "tableHeader", "image", "attachment", "horizontalRule"] as const;
const blockTypes = new Set<string>(RECORD_BLOCK_TYPES);
const blockIdPattern = /^[0-9a-f]{32}$/;

export function createRecordBlockId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class RecordDocumentError extends Error {
  readonly code = "INVALID_PATCH";
}

function fail(message: string): never { throw new RecordDocumentError(message); }

function checkShape(document: JSONContent, schema: Schema) {
  let count = 0;
  const visit = (node: JSONContent, depth: number, parent?: string) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 64 || ++count > 50000) {
      fail("Invalid document structure or size");
    }
    const type = typeof node.type === "string" ? schema.nodes[node.type] : undefined;
    if (!type) fail(`Unknown node: ${node.type}`);
    for (const key of Object.keys(node)) {
      if (!["type", "attrs", "content", "marks", "text"].includes(key)) fail(`Unknown node field: ${key}`);
    }
    checkAttrs(node.attrs, type.spec.attrs ?? {}, `node ${node.type}`);
    if (node.text !== undefined && (node.type !== "text" || typeof node.text !== "string")) fail("Invalid text node");
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks)) fail("Invalid marks");
      if (node.marks.length && (blockTypes.has(node.type ?? "") || parent === "codeBlock")) fail("Invalid marks on a block or code text");
      for (const mark of node.marks) {
        if (!mark || typeof mark !== "object") fail("Invalid mark");
        const markType = schema.marks[mark.type];
        if (!markType) fail(`Unknown mark: ${mark.type}`);
        if (Object.keys(mark).some((key) => key !== "type" && key !== "attrs")) fail("Unknown mark field");
        checkAttrs(mark.attrs, markType.spec.attrs ?? {}, `mark ${mark.type}`);
        if (mark.type === "link" && !isSafeRecordLink(mark.attrs?.href)) fail("Invalid link URL");
      }
    }
    const identity = node.type === "internalReference" ? "refId" : node.type === "tagMention" ? "tagId" : node.type === "contactMention" ? "contactId" : null;
    if (identity && positiveRecordObjectId(node.attrs?.[identity]) === null) fail("Invalid reference or mention identity");
    if (node.type === "internalReference" && !["note", "workspace_record", "todo", "document"].includes(node.attrs?.refKind ?? "note")) fail("Invalid internal reference kind");
    if (node.type === "internalReference" && node.attrs?.sourceRef != null) {
      const source = validateInternalReferenceSourceRef(node.attrs.sourceRef);
      if (node.attrs.refKind !== "document" || Number(source.object.id) !== positiveRecordObjectId(node.attrs.refId)) fail("Fixed File reference identity differs");
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content) || node.type === "text") fail("Invalid node content");
      node.content.forEach((child) => visit(child, depth + 1, node.type));
    }
  };
  visit(document, 0);
  if (document.type !== "doc") fail("Invalid document root");
  if (new TextEncoder().encode(JSON.stringify(document)).length > 1024 * 1024) fail("Invalid document size: limit is 1 MiB");
}

export function isSafeRecordLink(value: unknown) {
  if (typeof value !== "string" || !value || /[\u0000-\u0020\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000]/u.test(value)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1].toLowerCase();
  return scheme === undefined || ["http", "https", "ftp", "ftps", "mailto", "tel", "callto", "sms", "cid", "xmpp"].includes(scheme);
}

function checkAttrs(attrs: JSONContent["attrs"], allowed: Record<string, AttributeSpec>, owner: string) {
  if (attrs === undefined) return;
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) fail(`Invalid attributes in ${owner}`);
  for (const [key, value] of Object.entries(attrs)) {
    if (!Object.prototype.hasOwnProperty.call(allowed, key)) fail(`Unknown attribute ${key} in ${owner}`);
    if (key === "sourceRef" && owner === "node internalReference" && value !== null) {
      validateInternalReferenceSourceRef(value);
      continue;
    }
    const scalar = value === null || typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value));
    const widths = key === "colwidth" && Array.isArray(value)
      && value.length <= 1000 && value.every((width) => Number.isSafeInteger(width) && width >= 0 && width <= 1000000);
    if (!scalar && !widths) fail(`Invalid attribute value ${key} in ${owner}`);
    const defaultValue = allowed[key].default;
    if (defaultValue !== null && defaultValue !== undefined && typeof value !== typeof defaultValue) fail(`Invalid attribute type ${key} in ${owner}`);
    if (defaultValue === null && value !== null) {
      const valid = key === "colwidth" ? widths
        : ["documentId", "refId", "tagId", "contactId"].includes(key) ? positiveRecordObjectId(value) !== null
        : key === "width" || key === "height" ? positiveRecordObjectId(value) !== null && Number(value) <= 1000000
        : typeof value === "string";
      if (!valid) fail(`Invalid attribute type ${key} in ${owner}`);
    }
    if ((key === "colspan" || key === "rowspan") && (!Number.isSafeInteger(value) || value < 1 || value > 1000)) fail(`Invalid table span ${key}`);
    if (key === "level" && (!Number.isSafeInteger(value) || value < 1 || value > 4)) fail("Invalid heading level");
  }
}

function normalize(document: JSONContent, schema: Schema, initialize: boolean): JSONContent {
  checkShape(document, schema);
  const copy = structuredClone(document);
  const ids = new Set<string>();
  const visit = (node: JSONContent) => {
    if (node.type === "internalReference" && node.attrs?.sourceRef != null) node.attrs.refId = Number(node.attrs.refId);
    if (node.type === "image" || node.type === "attachment") {
      const path = node.attrs?.path;
      const urlKey = node.type === "image" ? "src" : "href";
      if (path !== null && path !== undefined) {
        if (typeof path !== "string" || !path || path.includes("\\") || path.includes(":") || path.includes("\0")
          || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
          fail("Invalid managed asset path: expected a Workspace-relative reference");
        }
        // Display URLs are derived from the managed reference; they must never
        // make a saved head or version depend on this machine's absolute path.
        node.attrs = { ...node.attrs, [urlKey]: null };
      } else if (node.type === "image" && (typeof node.attrs?.src !== "string" || !/^https?:\/\//i.test(node.attrs.src))) {
        fail("Invalid image source: expected a managed reference or remote image URL");
      } else if (node.type === "attachment" && node.attrs?.href != null
        && (typeof node.attrs.href !== "string" || !/^(https?:\/\/|#)/i.test(node.attrs.href))) {
        fail("Invalid managed attachment: an asset URL requires an explicit retained path");
      }
    }
    if (blockTypes.has(node.type ?? "")) {
      let id = node.attrs?.blockId;
      if ((id === undefined || id === null) && initialize) {
        do { id = createRecordBlockId(); } while (ids.has(id));
        node.attrs = { ...node.attrs, blockId: id };
      }
      if (typeof id !== "string" || !blockIdPattern.test(id)) fail(`Missing block ID or invalid block ID in ${node.type}`);
      if (ids.has(id)) fail(`Duplicate block ID: ${id}`);
      ids.add(id);
    }
    node.content?.forEach(visit);
  };
  if (initialize && !copy.content?.length) copy.content = [{ type: "paragraph" }];
  visit(copy);
  try {
    const parsed = schema.nodeFromJSON(copy);
    parsed.check();
    parsed.descendants((node) => {
      if (node.type.name === "table" && TableMap.get(node).problems?.length) fail("Invalid table grid");
      if (node.type.name === "tableRow" && node.childCount === 0) fail("Invalid empty table row");
    });
    const canonical = structuredClone(parsed.toJSON());
    // Adding an optional citation must not alter old committed body hashes or
    // prevent restoring immutable versions that predate this attribute.
    const omitEmptySourceRef = (node: JSONContent) => {
      if (node.type === "internalReference" && node.attrs?.sourceRef === null) delete node.attrs.sourceRef;
      node.content?.forEach(omitEmptySourceRef);
    };
    omitEmptySourceRef(canonical);
    return canonical;
  } catch (error) {
    fail(`Invalid editor document: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// These functions have no browser/DOM dependency. The editor and utility worker
// supply the same schema; unknown fields are diagnosed before PM can drop them.
export const initializeRecordDocument = (document: JSONContent, schema: Schema) => normalize(document, schema, true);
export const validateRecordDocument = (document: JSONContent, schema: Schema) => normalize(document, schema, false);

/** A distinct Record owns fresh identities even when copied from another tree. */
export function createRecordDocument(document: JSONContent, schema: Schema): JSONContent {
  checkShape(document, schema);
  const copy = structuredClone(document);
  const strip = (node: JSONContent) => {
    if (blockTypes.has(node.type ?? "") && node.attrs) delete node.attrs.blockId;
    node.content?.forEach(strip);
  };
  strip(copy);
  return initializeRecordDocument(copy, schema);
}

export function canonicalDocumentJson(document: JSONContent): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sorted(child)]),
    );
    return value;
  };
  return JSON.stringify(sorted(document));
}

export interface RecordBlockAnchor {
  blockId: string;
  parentBlockId: string | null;
  ordinal: number;
  node: JSONContent;
}

export function recordBlockIndex(document: JSONContent): RecordBlockAnchor[] {
  const result: RecordBlockAnchor[] = [];
  const visit = (node: JSONContent, parentBlockId: string | null, ordinal: number) => {
    const id = blockTypes.has(node.type ?? "") ? node.attrs?.blockId : undefined;
    if (typeof id === "string") result.push({ blockId: id, parentBlockId, ordinal, node });
    node.content?.forEach((child, index) => visit(child, typeof id === "string" ? id : parentBlockId, index));
  };
  visit(document, null, 0);
  return result;
}
