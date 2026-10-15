// @vitest-environment node
import { expect, it } from "vitest";
import { recordDocumentSchema } from "../components/rich-editor/extensions";
import { initializeRecordDocument } from "./record-document";
import { compareRecordDocuments } from "./record-version-compare";

const fixture = () => initializeRecordDocument({ type: "doc", content: ["A", "B", "C"].map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) }, recordDocumentSchema);
it("reports changed blocks and avoids marking siblings as moved after an insertion or deletion", () => {
  const before = fixture();
  const after = structuredClone(before);
  after.content!.splice(1, 1);
  after.content![0].content![0].text = "Changed";
  after.content!.unshift(initializeRecordDocument({ type: "doc", content: [{ type: "paragraph" }] }, recordDocumentSchema).content![0]);
  const diff = compareRecordDocuments(before, after);
  expect(diff.added).toEqual([after.content![0].attrs!.blockId]);
  expect(diff.deleted).toEqual([before.content![1].attrs!.blockId]);
  expect(diff.modified).toEqual([before.content![0].attrs!.blockId]);
  expect(diff.moved).toEqual([]);
});
it("detects reordering and parent changes while retaining block identity", () => {
  const before = fixture();
  const after = structuredClone(before);
  after.content = [after.content![1], after.content![0], after.content![2]];
  expect(compareRecordDocuments(before, after).moved).toEqual([before.content![1].attrs!.blockId]);
  const nested = structuredClone(before);
  const wrapper = initializeRecordDocument({ type: "doc", content: [{ type: "blockquote", content: [{ type: "paragraph" }] }] }, recordDocumentSchema).content![0];
  wrapper.content = [nested.content!.pop()!];
  nested.content!.push(wrapper);
  expect(compareRecordDocuments(before, nested).moved).toEqual([before.content![2].attrs!.blockId]);
});
it("does not repeat a text change on every ancestor container", () => {
  const before = initializeRecordDocument({ type: "doc", content: [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "Nested" }] }] }] }, recordDocumentSchema);
  const after = structuredClone(before);
  after.content![0].content![0].content![0].text = "Changed";
  const result = compareRecordDocuments(before, after);
  expect(result.modified).toEqual([before.content![0].content![0].attrs!.blockId]);
});
