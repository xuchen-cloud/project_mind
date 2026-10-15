import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { buildRichEditorExtensions } from "./extensions";
import { applyRecordIncomingDocument } from "./recordIncomingDocument";

const paragraph = (id: string, text: string) => ({ type: "paragraph", attrs: { blockId: id.repeat(32) }, content: [{ type: "text", text }] });
describe("incoming Record selection", () => {
  it("preserves the caret when appending, moving or modifying a stable block", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: buildRichEditorExtensions("", { stableBlocks: true }),
      content: { type: "doc", content: [paragraph("1", "First"), paragraph("2", "Second")] } });
    try {
      editor.commands.setTextSelection(10);
      const apply = (content: unknown[]) => applyRecordIncomingDocument(editor, editor.schema.nodeFromJSON({ type: "doc", content }));
      apply([paragraph("1", "First"), paragraph("2", "Second"), paragraph("3", "Append")]);
      expect(editor.state.selection.anchor).toBe(10);
      apply([paragraph("2", "Second"), paragraph("1", "First"), paragraph("3", "Append")]);
      expect(editor.state.selection.anchor).toBe(3);
      apply([paragraph("2", "Changed"), paragraph("1", "First"), paragraph("3", "Append")]);
      expect(editor.state.selection.anchor).toBe(3);
      expect(editor.state.selection.$anchor.parent.attrs.blockId).toBe("2".repeat(32));
      expect(editor.commands.undo()).toBe(false);
    } finally { editor.destroy(); }
  });
  it("moves the caret to a valid nearby position when its block was deleted", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: buildRichEditorExtensions("", { stableBlocks: true }),
      content: { type: "doc", content: [paragraph("1", "First"), paragraph("2", "Second")] } });
    try {
      editor.commands.setTextSelection(10);
      applyRecordIncomingDocument(editor, editor.schema.nodeFromJSON({ type: "doc", content: [paragraph("1", "First")] }));
      expect(editor.state.selection.$anchor.parent.isTextblock).toBe(true);
      expect(editor.state.selection.anchor).toBeLessThanOrEqual(editor.state.doc.content.size);
    } finally { editor.destroy(); }
  });
});
