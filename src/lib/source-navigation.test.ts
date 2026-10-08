import { act, renderHook } from "@testing-library/react";
import { Schema } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { useRecordSourceNavigation } from "../hooks/useRecordSourceNavigation";
import { parseSourceNavigation, revealSourceBlock, sourceBlockNavigationState } from "./source-navigation";

const firstId = "a".repeat(32);
const secondId = "b".repeat(32);
const route = (id: string, revision = 4) => new URLSearchParams({ sourceBlock: id, sourceRevision: String(revision) });

describe("source navigation", () => {
  it("parses only valid stable anchors, numeric revisions and nonnegative timestamps", () => {
    expect(parseSourceNavigation(route(firstId))).toMatchObject({ blockId: firstId, revision: 4, error: null });
    expect(parseSourceNavigation(new URLSearchParams("sourceTimeMs=1234.5"))).toMatchObject({ timeMs: 1234.5, error: null });
    expect(parseSourceNavigation(new URLSearchParams())).toMatchObject({ requested: false, error: null });
    for (const query of ["sourceTimeMs=-1", "sourceTimeMs=Infinity", "sourceTimeMs=", "sourceRevision=1.5",
      "sourceRevision=9007199254740992", "sourceBlock=guessed-text"]) {
      expect(parseSourceNavigation(new URLSearchParams(query)).error).toBeTruthy();
    }
  });

  it("waits for visible canonical hydration and refuses an old revision despite a surviving block ID", () => {
    const request = parseSourceNavigation(route(firstId));
    expect(sourceBlockNavigationState(request, false, true, 4)).toEqual({ navigation: null, message: null });
    expect(sourceBlockNavigationState(request, true, false, 4).navigation).toBeNull();
    expect(sourceBlockNavigationState(request, true, true, 5)).toMatchObject({ navigation: null, message: expect.stringContaining("引用版本已变化") });
    expect(sourceBlockNavigationState(request, true, true, 4).navigation?.blockId).toBe(firstId);
  });

  it("finds duplicate text by PM block identity without editing the document or selection", () => {
    const schema = new Schema({ nodes: {
      doc: { content: "paragraph+" }, text: {},
      paragraph: { content: "text*", attrs: { blockId: { default: null } } },
    } });
    const doc = schema.node("doc", null, [schema.node("paragraph", { blockId: firstId }, schema.text("same text")),
      schema.node("paragraph", { blockId: secondId }, schema.text("same text"))]);
    const state = EditorState.create({ doc });
    const first = document.createElement("p");
    const second = document.createElement("p");
    first.scrollIntoView = vi.fn(); second.scrollIntoView = vi.fn();
    const nodeDOM = vi.fn((pos: number) => pos === 0 ? first : second);
    const editor = { state, view: { nodeDOM, dispatch: vi.fn() } } as unknown as Pick<Editor, "state" | "view">;
    const before = state.doc.toJSON(); const selection = state.selection;
    expect(revealSourceBlock(editor, secondId)).toBe(true);
    expect(nodeDOM).toHaveBeenCalledWith(doc.child(0).nodeSize);
    expect(second.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(first.scrollIntoView).not.toHaveBeenCalled();
    expect(revealSourceBlock(editor, "c".repeat(32))).toBe(false);
    expect(editor.view.dispatch).not.toHaveBeenCalled();
    expect(state.doc.toJSON()).toEqual(before);
    expect(state.selection).toBe(selection);
  });

  it("recomputes a second anchor on the same resident object and defers hidden navigation", () => {
    const { result, rerender } = renderHook(({ params, visible }) => useRecordSourceNavigation(params, visible, true, 4),
      { initialProps: { params: route(firstId), visible: true } });
    act(() => result.current.onSourceBlockResult(false));
    expect(result.current.message).toContain("引用段落已删除或变更");
    rerender({ params: route(secondId), visible: false });
    expect(result.current.navigation).toBeNull();
    expect(result.current.message).toBeNull();
    rerender({ params: route(secondId), visible: true });
    expect(result.current.navigation?.blockId).toBe(secondId);
    expect(result.current.message).toBeNull();
    act(() => result.current.onSourceBlockResult(true));
    expect(result.current.message).toContain("已定位引用段落");
  });
});
