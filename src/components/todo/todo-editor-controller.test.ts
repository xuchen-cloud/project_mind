import { describe, expect, it } from "vitest";

import { getTodoEditorDerivedState } from "./todo-editor-controller";

function derive(draft: string) {
  return getTodoEditorDerivedState({
    draft,
    editing: true,
    selectionStart: draft.length,
    canCreateMentions: true,
  });
}

describe("getTodoEditorDerivedState", () => {
  it("does not treat an all-numeric @ query as a contact mention", () => {
    expect(derive("@0315").mentionTrigger).toBeNull();
    expect(derive("安排 @20270315").mentionTrigger).toBeNull();
  });

  it("continues to treat names containing non-digits as contact mentions", () => {
    expect(derive("@张三").mentionTrigger?.query).toBe("张三");
    expect(derive("@user2").mentionTrigger?.query).toBe("user2");
  });
});
