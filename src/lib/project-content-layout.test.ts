import { describe, expect, it } from "vitest";
import { contentLayoutKey, emptyContentLayout, getContentLayout } from "./project-content-layout";

describe("project content layout selectors", () => {
  it("returns a stable empty selector while new mutable layouts remain independent", () => {
    const scope = { workspaceId: "workspace", projectId: 1 };
    const empty = getContentLayout({ layouts: {} }, scope);
    expect(getContentLayout({ layouts: {} }, scope)).toBe(empty);
    expect(getContentLayout({ layouts: {} }, { ...scope, projectId: 2 })).toBe(empty);
    expect(empty).toEqual({
      tabs: [], panes: [{ id: "left", tabIds: [], selectedTabId: null }], focusedPaneId: "left", ratio: 0.5,
    });
    const fresh = emptyContentLayout();
    fresh.panes[0].tabIds.push("temporary");
    expect(emptyContentLayout().panes[0].tabIds).toEqual([]);
    expect(empty.panes[0].tabIds).toEqual([]);
    const saved = emptyContentLayout();
    expect(getContentLayout({ layouts: { [contentLayoutKey(scope)]: saved } }, scope)).toBe(saved);
  });

  it("keys arbitrary workspace IDs without delimiter collisions", () => {
    expect(contentLayoutKey({ workspaceId: 'work:1,"x"', projectId: 2 }))
      .not.toBe(contentLayoutKey({ workspaceId: 'work:1,"x":2', projectId: 1 }));
  });
});
