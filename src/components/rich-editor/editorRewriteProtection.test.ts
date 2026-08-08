import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it, vi } from "vitest";

import {
  EDITOR_REWRITE_PROTECTION_PLUGIN_KEY,
  createEditorRewriteProtectionPlugin,
  markEditorRewriteTransaction,
} from "./editorRewriteProtection";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", group: "block" },
    text: { group: "inline" },
  },
  marks: {
    strong: {},
  },
});

function paragraph(text: string) {
  return schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
}

function createProtectedState(onBlocked = vi.fn()) {
  const head = paragraph("head");
  const target = paragraph("AI");
  const tail = paragraph("tail");
  let state = EditorState.create({
    schema,
    doc: schema.nodes.doc.create(null, [head, target, tail]),
    plugins: [createEditorRewriteProtectionPlugin({ onBlocked })],
  });
  const range = { from: head.nodeSize, to: head.nodeSize + target.nodeSize };
  state = state.apply(
    state.tr.setMeta(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY, {
      type: "set",
      range,
    }),
  );
  return { state, range, onBlocked };
}

describe("editor rewrite protection", () => {
  it("allows edits outside the AI range and maps the protected positions", () => {
    const setup = createProtectedState();
    const nextState = setup.state.apply(setup.state.tr.insertText("x", 1));

    expect(nextState.doc.textContent).toBe("xheadAItail");
    expect(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(nextState)?.active).toEqual({
      from: setup.range.from + 1,
      to: setup.range.to + 1,
    });
    expect(setup.onBlocked).not.toHaveBeenCalled();
  });

  it("blocks typing, deletion, and formatting that changes the AI range", async () => {
    const setup = createProtectedState();
    const typedState = setup.state.apply(
      setup.state.tr.insertText("x", setup.range.from + 1),
    );
    const deletedState = setup.state.apply(
      setup.state.tr.delete(setup.range.from, setup.range.to),
    );
    const formattedState = setup.state.apply(
      setup.state.tr.addMark(
        setup.range.from + 1,
        setup.range.to - 1,
        schema.marks.strong.create(),
      ),
    );

    expect(typedState).toBe(setup.state);
    expect(deletedState).toBe(setup.state);
    expect(formattedState).toBe(setup.state);
    await Promise.resolve();
    expect(setup.onBlocked).toHaveBeenCalledTimes(1);
  });

  it("allows internal AI replacement and tracks the rewritten range", () => {
    const setup = createProtectedState();
    const replacement = paragraph("rewritten");
    const transaction = markEditorRewriteTransaction(
      setup.state.tr.replaceWith(setup.range.from, setup.range.to, replacement),
    );
    const nextState = setup.state.apply(transaction);

    expect(nextState.doc.textContent).toBe("headrewrittentail");
    expect(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(nextState)?.active).toEqual({
      from: setup.range.from,
      to: setup.range.from + replacement.nodeSize,
    });
  });

  it("protects multiple non-overlapping Editor Skill targets independently", () => {
    const setup = createProtectedState();
    const secondRange = { from: setup.range.to, to: setup.state.doc.content.size };
    const withSecond = setup.state.apply(
      setup.state.tr.setMeta(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY, {
        type: "set",
        key: "second",
        range: secondRange,
      }),
    );
    const blocked = withSecond.apply(withSecond.tr.insertText("x", secondRange.from + 1));
    const outside = withSecond.apply(withSecond.tr.insertText("x", 1));

    expect(blocked).toBe(withSecond);
    expect(outside.doc.textContent).toBe("xheadAItail");
    expect(Object.keys(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(outside) ?? {})).toEqual([
      "active",
      "second",
    ]);
  });
});
