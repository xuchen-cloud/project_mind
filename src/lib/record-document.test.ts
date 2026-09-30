import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { buildRichEditorExtensions } from "../components/rich-editor/extensions";
import { canonicalDocumentJson, initializeRecordDocument, validateRecordDocument, recordBlockIndex } from "./record-document";

const schema = getSchema(buildRichEditorExtensions("", { stableBlocks: true }));

describe("Record canonical document", () => {
  it("initializes every nested block once and keeps anchors across text and mark edits", () => {
    const document = initializeRecordDocument({ type: "doc", content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [
        { type: "paragraph", content: [{ type: "text", text: "Item" }] },
      ] }] },
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [{ type: "paragraph" }] }] }] },
    ] }, schema);
    const blocks = recordBlockIndex(document);
    expect(blocks).toHaveLength(8);
    expect(new Set(blocks.map((block) => block.blockId)).size).toBe(8);
    expect(blocks.every((block) => /^[0-9a-f]{32}$/.test(block.blockId))).toBe(true);
    expect(blocks[3].parentBlockId).toBe(blocks[2].blockId);
    const edited = structuredClone(document);
    edited.content![0].content![0].text = "Changed heading";
    edited.content![0].content![0].marks = [{ type: "bold" }];
    expect(recordBlockIndex(validateRecordDocument(edited, schema)).map((block) => block.blockId))
      .toEqual(blocks.map((block) => block.blockId));
    expect(initializeRecordDocument(document, schema)).toEqual(document);
  });

  it("rejects unknown structure and attributes before the editor schema can discard them", () => {
    expect(() => initializeRecordDocument({ type: "doc", content: [{ type: "privateWidget", attrs: { original: "preserve me" } }] }, schema))
      .toThrow(/Unknown node/);
    expect(() => initializeRecordDocument({ type: "doc", content: [{ type: "paragraph", attrs: { privateMetadata: "preserve me" } }] }, schema))
      .toThrow(/Unknown attribute/);
    expect(() => initializeRecordDocument({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Text", marks: [{ type: "unknownMark" }] }] }] }, schema))
      .toThrow(/Unknown mark/);
    expect(() => initializeRecordDocument({ type: "doc", content: [{ type: "bulletList", content: [{ type: "heading" }] }] }, schema))
      .toThrow(/Invalid/);
  });

  it("validates anchor uniqueness and produces deterministic JSON without mutating input", () => {
    const document = initializeRecordDocument({ type: "doc", content: [{ type: "paragraph" }, { type: "paragraph" }] }, schema);
    const duplicate = structuredClone(document);
    duplicate.content![1].attrs!.blockId = duplicate.content![0].attrs!.blockId;
    expect(() => validateRecordDocument(duplicate, schema)).toThrow(/Duplicate block/);
    const missing = { type: "doc", content: [{ type: "paragraph" }] };
    expect(() => validateRecordDocument(missing, schema)).toThrow(/Missing block/);
    expect(canonicalDocumentJson(document)).toBe(canonicalDocumentJson(JSON.parse(JSON.stringify(document))));
    expect(missing.content[0]).not.toHaveProperty("attrs");
  });
});
