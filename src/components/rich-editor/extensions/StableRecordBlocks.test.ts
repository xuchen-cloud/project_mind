import { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { describe, expect, it } from "vitest";
import { buildRichEditorExtensions } from "../extensions";

const firstId = "1".repeat(32);
function editorWithParagraph(text: string) {
  return new Editor({ element: document.createElement("div"),
    extensions: buildRichEditorExtensions("", { stableBlocks: true }),
    content: { type: "doc", content: [{ type: "paragraph", attrs: { blockId: firstId }, content: [{ type: "text", text }] }] } });
}

describe("stable Record block anchors", () => {
  it("keeps the original anchor when a duplicate is inserted before it", () => {
    const editor = editorWithParagraph("Original");
    try {
      editor.commands.insertContentAt(0, editor.getJSON().content![0]);
      const nodes = editor.getJSON().content!;
      expect(nodes).toHaveLength(2);
      expect(nodes[1].attrs!.blockId).toBe(firstId);
      expect(nodes[0].attrs!.blockId).toMatch(/^[0-9a-f]{32}$/);
      expect(nodes[0].attrs!.blockId).not.toBe(firstId);
      expect(editor.getHTML()).toContain(`data-block-id="${firstId}"`);
    } finally { editor.destroy(); }
  });

  it("split preserves the left anchor, merge preserves the first anchor, and undo restores IDs", () => {
    const editor = editorWithParagraph("abcd");
    try {
      editor.commands.setTextSelection(3);
      editor.commands.splitBlock();
      const split = editor.getJSON().content!;
      expect(split[0].attrs!.blockId).toBe(firstId);
      const rightId = split[1].attrs!.blockId;
      expect(rightId).toMatch(/^[0-9a-f]{32}$/);
      expect(rightId).not.toBe(firstId);
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.joinBackward();
      expect(editor.getJSON().content).toHaveLength(1);
      expect(editor.getJSON().content![0].attrs!.blockId).toBe(firstId);
      editor.commands.undo();
      const restored = editor.getJSON().content!;
      expect(restored.map((node) => node.attrs!.blockId)).toEqual([firstId, rightId]);
    } finally { editor.destroy(); }
  });

  it("ordinary text and mark changes keep the block anchor", () => {
    const editor = editorWithParagraph("Text");
    try {
      editor.commands.setTextSelection({ from: 1, to: 5 });
      editor.commands.toggleBold();
      editor.commands.insertContent("Changed");
      expect(editor.getJSON().content![0].attrs!.blockId).toBe(firstId);
    } finally { editor.destroy(); }
  });
});

function clipboardEvent(type: "copy" | "cut" | "paste", values = new Map<string, string>()) {
  const data = { clearData: () => values.clear(), setData: (kind: string, value: string) => values.set(kind, value),
    getData: (kind: string) => values.get(kind) ?? "", files: [], types: [...values.keys()] };
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  return { event, values };
}
function clipboardEditor(recordKey: string) {
  return new Editor({ element: document.createElement("div"),
    extensions: buildRichEditorExtensions("", { stableBlocks: true, recordKey }),
    content: { type: "doc", content: [{ type: "paragraph", attrs: { blockId: firstId }, content: [{ type: "text", text: "Moved" }] }] } });
}
it("pasting copied or foreign Record HTML allocates new IDs even when there is no collision", () => {
  const editor = clipboardEditor("workspace:target");
  try {
    editor.commands.selectAll();
    editor.view.pasteHTML(`<p data-block-id="${"f".repeat(32)}">Foreign</p>`, clipboardEvent("paste").event as ClipboardEvent);
    expect(editor.getJSON().content![0].attrs!.blockId).not.toBe("f".repeat(32));
  } finally { editor.destroy(); }
});
it("cut within the same Record retains IDs once; cross Record paste gets fresh anchors", () => {
  const source = clipboardEditor("workspace:source");
  const target = clipboardEditor("workspace:target");
  try {
    source.commands.setNodeSelection(0);
    const cut = clipboardEvent("cut");
    source.view.dom.dispatchEvent(cut.event);
    expect(source.getJSON().content!.some((node) => node.attrs!.blockId === firstId)).toBe(false);
    source.commands.selectAll();
    source.view.dom.dispatchEvent(clipboardEvent("paste", cut.values).event);
    expect(source.getJSON().content![0].attrs!.blockId).toBe(firstId);
    target.commands.selectAll();
    target.view.dom.dispatchEvent(clipboardEvent("paste", cut.values).event);
    expect(target.getJSON().content![0].attrs!.blockId).not.toBe(firstId);
    source.commands.selectAll();
    source.view.dom.dispatchEvent(clipboardEvent("paste", cut.values).event);
    expect(source.getJSON().content![0].attrs!.blockId).not.toBe(firstId);
  } finally { source.destroy(); target.destroy(); }
});
it("cut from a read-only Record copies content without deleting it or granting move semantics", () => {
  const source = clipboardEditor("workspace:readonly");
  try {
    source.setEditable(false);
    source.commands.setNodeSelection(0);
    const cut = clipboardEvent("cut"); source.view.dom.dispatchEvent(cut.event);
    expect(source.getText()).toBe("Moved");
    expect(source.getJSON().content![0].attrs!.blockId).toBe(firstId);
    expect(cut.values.get("text/html")).toContain("Moved");
    expect(cut.values.has("application/x-project-mind-record-cut")).toBe(false);
  } finally { source.destroy(); }
});
