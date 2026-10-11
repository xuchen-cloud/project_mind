import { describe, expect, it } from "vitest";
import { contentLayoutKey, emptyContentLayout, getContentLayout, sanitizeContentLayouts, sanitizeContentView } from "./project-content-layout";

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

  it("discards mixed identity types only in the damaged project", () => {
    const valid = emptyContentLayout();
    const damaged = { ...emptyContentLayout(), tabs: [
      { id: "one", object: { kind: "file", id: 1, title: "File" }, view: {} },
      { id: "two", object: { kind: "file", id: "1", title: "Duplicate" }, view: {} },
    ], panes: [{ id: "left", tabIds: ["one", "two"], selectedTabId: "one" }] };
    const first = contentLayoutKey({ workspaceId: "workspace", projectId: 1 });
    const second = contentLayoutKey({ workspaceId: "workspace", projectId: 2 });
    expect(sanitizeContentLayouts({ [first]: damaged, [second]: valid })).toEqual({ [second]: valid });
  });

  it("retains fit-width zoom and independent version positions without business content", () => {
    expect(sanitizeContentView({ zoom: 0, fileViews: { 2: { scrollTop: 240, zoom: 0 }, 3: { scrollTop: 80, zoom: 1.5, bytes: "discard" } }, bytes: "discard" }))
      .toEqual({ zoom: 0, fileViews: { 2: { scrollTop: 240, zoom: 0 }, 3: { scrollTop: 80, zoom: 1.5 } } });
    expect(sanitizeContentView({ fileViews: { latest: { scrollTop: 20 } } })).toBeNull();
    expect(sanitizeContentView({ fileViews: { 2: { zoom: -1 } } })).toBeNull();
  });

  it("keeps truthful source coordinates and rejects invalid ranges", () => {
    expect(sanitizeContentView({ sourceLocator: { kind: "page", page: 2, start: 0, end: 12, text: "discard" } }))
      .toEqual({ sourceLocator: { kind: "page", page: 2, start: 0, end: 12 } });
    expect(sanitizeContentView({ sourceLocator: { kind: "line", start: 1, end: 3 } }))
      .toEqual({ sourceLocator: { kind: "line", start: 1, end: 3 } });
    expect(sanitizeContentView({ sourceLocator: { kind: "paragraph", start: 0, end: 1 } })).toBeNull();
    expect(sanitizeContentView({ sourceLocator: { kind: "page", page: 1, start: 0, end: 0 } })).toBeNull();
  });
});
