import type { JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { canonicalDocumentJson, createRecordBlockId, recordBlockIndex, RECORD_BLOCK_TYPES,
  RecordDocumentError, validateRecordDocument } from "./record-document";

export type RecordPatchOperation =
  | { op: "replace"; blockId: string; expectedBlockHash: string; block: JSONContent }
  | { op: "delete"; blockId: string; expectedBlockHash: string }
  | { op: "insert_after"; anchorBlockId: string; blocks: JSONContent[] }
  | { op: "append"; parentBlockId: string | null; position?: "start" | "end"; blocks: JSONContent[] }
  | { op: "append_inline"; blockId: string; expectedBlockHash: string; text: string };
export interface RecordPatchNormalization {
  kind: "remove_empty_container" | "empty_container_paragraph" | "empty_document_paragraph";
  blockId: string | null;
}
export interface RecordPatchPreview {
  document: JSONContent;
  createdBlockIds: string[];
  deletedBlockIds: string[];
  normalizations: RecordPatchNormalization[];
  noChange: boolean;
}
const blockTypes = new Set<string>(RECORD_BLOCK_TYPES);
const idPattern = /^[0-9a-f]{32}$/;
function fail(message: string): never { throw new RecordDocumentError(message); }
export async function recordBlockHash(block: JSONContent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDocumentJson(block));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// All anchors refer to one base tree. Allocation and repair happen only on a
// private copy; validation must succeed before any persistence is permitted.
export async function applyRecordPatch(base: JSONContent, operations: RecordPatchOperation[], schema: Schema): Promise<RecordPatchPreview> {
  const document = validateRecordDocument(base, schema);
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100
    || new TextEncoder().encode(JSON.stringify(operations)).length > 1024 * 1024) fail("Invalid patch size or operation count");
  const originalJson = canonicalDocumentJson(document);
  const index = recordBlockIndex(document);
  const anchors = new Map(index.map((entry) => [entry.blockId, entry]));
  const targets = new Set<string>();
  const operationFields: Record<string, string[]> = {
    replace: ["op", "blockId", "expectedBlockHash", "block"], delete: ["op", "blockId", "expectedBlockHash"],
    insert_after: ["op", "anchorBlockId", "blocks"], append: ["op", "parentBlockId", "position", "blocks"],
    append_inline: ["op", "blockId", "expectedBlockHash", "text"],
  };
  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)
      || !Object.prototype.hasOwnProperty.call(operationFields, operation.op)
      || Object.keys(operation).some((key) => !operationFields[operation.op].includes(key))) fail("Unknown patch operation or field");
    const target = operation.op === "append" ? operation.parentBlockId
      : operation.op === "insert_after" ? operation.anchorBlockId : operation.blockId;
    if (target !== null && (typeof target !== "string" || !idPattern.test(target) || !anchors.has(target))) fail("Unknown block anchor");
    const key = target ?? "document";
    if (targets.has(key)) fail("Duplicate patch target");
    targets.add(key);
    if ("expectedBlockHash" in operation) {
      if (typeof operation.expectedBlockHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(operation.expectedBlockHash)
        || await recordBlockHash(anchors.get(operation.blockId)!.node) !== operation.expectedBlockHash) fail("Block hash differs from base snapshot");
    }
    if (operation.op === "append" && operation.position !== undefined && operation.position !== "start" && operation.position !== "end") fail("Invalid append position");
    if (operation.op === "append_inline" && (typeof operation.text !== "string"
      || !["paragraph", "heading", "codeBlock"].includes(anchors.get(operation.blockId)!.node.type ?? ""))) fail("Invalid inline append target or text");
    if ("blocks" in operation && (!Array.isArray(operation.blocks) || operation.blocks.length === 0)) fail("Empty block insertion");
  }
  for (const target of targets) {
    let parent = anchors.get(target)?.parentBlockId;
    while (parent) {
      if (targets.has(parent)) fail("Overlapping ancestor and descendant patch targets");
      parent = anchors.get(parent)?.parentBlockId;
    }
  }
  const occupied = new Set(anchors.keys());
  let inputNodes = 0;
  const newId = () => {
    let id: string;
    do { id = createRecordBlockId(); } while (occupied.has(id));
    occupied.add(id);
    return id;
  };
  const allocate = (input: JSONContent, depth = 0): JSONContent => {
    if (!input || typeof input !== "object" || Array.isArray(input) || depth > 64 || ++inputNodes > 50000) fail("Invalid inserted block structure");
    if (input.attrs?.blockId != null) fail("New block IDs must be allocated by the Host");
    const copy = { ...input, ...(input.attrs ? { attrs: { ...input.attrs } } : {}) };
    if (blockTypes.has(copy.type ?? "")) copy.attrs = { ...copy.attrs, blockId: newId() };
    if (input.content !== undefined) {
      if (!Array.isArray(input.content)) fail("Invalid inserted block content");
      copy.content = input.content.map((child) => allocate(child, depth + 1));
    }
    return copy;
  };
  const insertions = (blocks: JSONContent[]) => blocks.map((block) => {
    if (!blockTypes.has(block?.type ?? "")) fail("Insertion requires addressable blocks");
    return allocate(block);
  });
  const parentOf = (id: string) => {
    const parentId = anchors.get(id)!.parentBlockId;
    return parentId ? anchors.get(parentId)!.node : document;
  };
  for (const operation of operations) {
    if (operation.op === "append") {
      const parent = operation.parentBlockId ? anchors.get(operation.parentBlockId)!.node : document;
      const blocks = insertions(operation.blocks);
      if (parent.type !== "doc" && (!schema.nodes[parent.type ?? ""]?.isBlock || schema.nodes[parent.type!].isLeaf)) fail("Invalid block append container");
      parent.content = operation.position === "start" ? [...blocks, ...(parent.content ?? [])] : [...(parent.content ?? []), ...blocks];
    } else if (operation.op === "insert_after") {
      const parent = parentOf(operation.anchorBlockId);
      const at = parent.content!.findIndex((child) => child.attrs?.blockId === operation.anchorBlockId);
      parent.content!.splice(at + 1, 0, ...insertions(operation.blocks));
    } else if (operation.op === "append_inline") {
      if (operation.text) {
        const target = anchors.get(operation.blockId)!.node;
        target.content = [...(target.content ?? []), { type: "text", text: operation.text }];
      }
    } else {
      const parent = parentOf(operation.blockId);
      const at = parent.content!.findIndex((child) => child.attrs?.blockId === operation.blockId);
      if (operation.op === "delete") parent.content!.splice(at, 1);
      else {
        if (!blockTypes.has(operation.block?.type ?? "")) fail("Replacement requires an addressable block");
        const replacement = allocate(operation.block);
        replacement.attrs = { ...replacement.attrs, blockId: operation.blockId };
        parent.content![at] = replacement;
      }
    }
  }
  const normalizations: RecordPatchNormalization[] = [];
  const emptyParagraph = (): JSONContent => ({ type: "paragraph", attrs: { blockId: newId() } });
  const repair = (node: JSONContent): JSONContent | null => {
    if (node.content) node.content = node.content.map(repair).filter((child): child is JSONContent => child !== null);
    if (["bulletList", "orderedList", "taskList", "table", "tableRow", "blockquote"].includes(node.type ?? "") && !node.content?.length && anchors.has(node.attrs?.blockId)) {
      normalizations.push({ kind: "remove_empty_container", blockId: node.attrs!.blockId });
      return null;
    }
    if (["tableCell", "tableHeader", "listItem", "taskItem"].includes(node.type ?? "") && !node.content?.length && anchors.has(node.attrs?.blockId)) {
      node.content = [emptyParagraph()];
      normalizations.push({ kind: "empty_container_paragraph", blockId: node.attrs!.blockId });
    }
    return node;
  };
  repair(document);
  if (!document.content?.length) {
    document.content = [emptyParagraph()];
    normalizations.push({ kind: "empty_document_paragraph", blockId: null });
  }
  const validated = validateRecordDocument(document, schema);
  const afterIds = new Set(recordBlockIndex(validated).map((entry) => entry.blockId));
  return { document: validated, createdBlockIds: [...afterIds].filter((id) => !anchors.has(id)),
    deletedBlockIds: index.filter((entry) => !afterIds.has(entry.blockId)).map((entry) => entry.blockId), normalizations,
    noChange: canonicalDocumentJson(validated) === originalJson };
}
