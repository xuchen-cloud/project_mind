// @vitest-environment node
import type { JSONContent } from "@tiptap/core";
import { expect, it } from "vitest";
import { recordDocumentSchema as schema } from "../components/rich-editor/extensions";
import { initializeRecordDocument, recordBlockIndex } from "./record-document";
import { applyRecordPatch, recordBlockHash } from "./record-patch";

const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const fixture = () => initializeRecordDocument({ type: "doc", content: [paragraph("First"), paragraph("Second"), paragraph("Third")] }, schema);
const id = (node: JSONContent) => node.attrs!.blockId as string;

it("previews replace, append and delete atomically with new child IDs and retained target IDs", async () => {
  const document = fixture();
  const original = structuredClone(document);
  const [first, second, third] = document.content!;
  const result = await applyRecordPatch(document, [
    { op: "replace", blockId: id(first), expectedBlockHash: await recordBlockHash(first), block: { type: "blockquote", content: [paragraph("Replacement")] } },
    { op: "append", parentBlockId: null, blocks: [paragraph("Appended")] },
    { op: "delete", blockId: id(second), expectedBlockHash: await recordBlockHash(second) },
  ], schema);
  expect(document).toEqual(original);
  expect(result.document.content!.map(id)).toEqual([id(first), id(third), result.createdBlockIds.at(-1)]);
  expect(result.createdBlockIds).toHaveLength(2);
  expect(result.deletedBlockIds).toEqual([id(second)]);
  expect(result.document.content![0].content![0].content![0].text).toBe("Replacement");
});

it("rejects stale hashes, unknown anchors, duplicate and overlapping targets without modifying input", async () => {
  const document = initializeRecordDocument({ type: "doc", content: [{ type: "blockquote", content: [paragraph("Nested")] }] }, schema);
  const parent = document.content![0];
  const child = parent.content![0];
  const original = structuredClone(document);
  const remove = { op: "delete" as const, blockId: id(child), expectedBlockHash: await recordBlockHash(child) };
  await expect(applyRecordPatch(document, [remove, remove], schema)).rejects.toThrow(/Duplicate/);
  await expect(applyRecordPatch(document, [remove, { op: "append", parentBlockId: id(parent), blocks: [paragraph("Conflicting")] }], schema)).rejects.toThrow(/Overlapping/);
  await expect(applyRecordPatch(document, [{ ...remove, expectedBlockHash: `sha256:${"0".repeat(64)}` }], schema)).rejects.toThrow(/hash/);
  await expect(applyRecordPatch(document, [{ op: "insert_after", anchorBlockId: "a".repeat(32), blocks: [paragraph("Unknown")] }], schema)).rejects.toThrow(/Unknown/);
  await expect(applyRecordPatch(document, [{ op: "append", parentBlockId: null, blocks: [{ type: "privateWidget" }] }], schema)).rejects.toThrow();
  await expect(applyRecordPatch(document, [{ op: "append", parentBlockId: null, blocks: [child] }], schema)).rejects.toThrow(/allocate/);
  expect(document).toEqual(original);
});

it("normalizes deletion of the last table row and last cell paragraph with explicit retired and created IDs", async () => {
  const document = initializeRecordDocument({ type: "doc", content: [{ type: "table", content: [
    { type: "tableRow", content: [{ type: "tableCell", content: [paragraph("Cell")] }] },
  ] }] }, schema);
  const [table, row, cell, text] = recordBlockIndex(document).map((entry) => entry.node);
  const emptyCell = await applyRecordPatch(document, [{ op: "delete", blockId: id(text), expectedBlockHash: await recordBlockHash(text) }], schema);
  expect(emptyCell.createdBlockIds).toHaveLength(1);
  expect(emptyCell.document.content![0].content![0].content![0].content![0].type).toBe("paragraph");
  expect(emptyCell.normalizations).toContainEqual({ kind: "empty_container_paragraph", blockId: id(cell) });
  const noTable = await applyRecordPatch(document, [{ op: "delete", blockId: id(row), expectedBlockHash: await recordBlockHash(row) }], schema);
  expect(noTable.deletedBlockIds).toEqual(expect.arrayContaining([id(table), id(row), id(cell), id(text)]));
  expect(noTable.document.content![0].type).toBe("paragraph");
  expect(noTable.createdBlockIds).toHaveLength(1);
  expect(noTable.normalizations).toContainEqual({ kind: "remove_empty_container", blockId: id(table) });
});

it("appends inline text literally, inserts against one snapshot and detects actual no-change", async () => {
  const document = fixture();
  const [first, second] = document.content!;
  const result = await applyRecordPatch(document, [
    { op: "append_inline", blockId: id(first), expectedBlockHash: await recordBlockHash(first), text: "<strong>literal</strong>" },
    { op: "insert_after", anchorBlockId: id(second), blocks: [paragraph("Inserted")] },
  ], schema);
  expect(result.document.content![0].content!.map((node) => node.text).join("")).toBe("First<strong>literal</strong>");
  expect(result.document.content![2].content![0].text).toBe("Inserted");
  const unchanged = await applyRecordPatch(document, [{ op: "append_inline", blockId: id(first), expectedBlockHash: await recordBlockHash(first), text: "" }], schema);
  expect(unchanged.noChange).toBe(true);
  expect(unchanged.createdBlockIds).toEqual([]);
});
