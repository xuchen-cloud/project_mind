import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { buildRichEditorExtensions } from "../extensions";

const sourceRef = { object: { workspaceId: "w1", scope: { kind: "project", projectId: 7 }, kind: "file", id: "51" },
  revision: `sha256:${"a".repeat(64)}`, fileVersion: 2, recordVersion: null, blockId: null, locator: null,
  title: '材料 "<>&.pdf', excerpt: "证据 & <quote>" };
describe("fixed InternalReference", () => {
  it("retains exact evidence through HTML copy/paste and canonical node JSON", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: buildRichEditorExtensions("", { stableBlocks: true }),
      content: { type: "doc", content: [{ type: "paragraph", attrs: { blockId: "a".repeat(32) }, content: [
        { type: "internalReference", attrs: { refKind: "document", refId: 51, label: "材料", sourceRef } } ] }] } });
    const destination = new Editor({ element: document.createElement("div"), extensions: buildRichEditorExtensions("", { stableBlocks: true }) });
    try {
      const html = editor.getHTML();
      expect(html).toContain("data-source-ref=");
      destination.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
      expect(destination.getJSON().content![0].content![0].attrs!.sourceRef).toEqual(sourceRef);
      destination.commands.setContent(destination.getJSON());
      expect(destination.getJSON().content![0].content![0].attrs!.sourceRef).toEqual(sourceRef);
    } finally { editor.destroy(); destination.destroy(); }
  });
});
