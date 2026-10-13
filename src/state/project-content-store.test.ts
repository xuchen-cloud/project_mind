import { beforeEach, describe, expect, it } from "vitest";
import { contentLayoutKey, getContentLayout, type ProjectContentLayout } from "../lib/project-content-layout";
import { useProjectContentStore } from "./project-content-store";

const scope = { workspaceId: "workspace-a", projectId: 1 };
const file = { kind: "file", id: 7, title: "Source" } as const;
const store = () => useProjectContentStore.getState();
const layout = (target = scope) => getContentLayout(store(), target);

describe("project content state", () => {
  beforeEach(() => {
    useProjectContentStore.setState({ layouts: {} });
    useProjectContentStore.persist.clearStorage();
  });

  it("opens in a single pane and isolates objects by workspace, project and kind", () => {
    const a = store().open(scope, file, { paneId: "right" });
    const record = store().open(scope, { ...file, kind: "record" });
    const session = store().open(scope, { ...file, kind: "session", id: "7" });
    const project = { ...scope, projectId: 2 };
    const workspace = { ...scope, workspaceId: "workspace-b" };
    store().open(project, file);
    store().open(workspace, file);
    expect(layout().panes).toEqual([
      { id: "left", tabIds: [a, record, session], selectedTabId: session },
    ]);
    expect(layout().tabs).toHaveLength(3);
    expect(layout(project).tabs).toHaveLength(1);
    expect(layout(workspace).tabs).toHaveLength(1);
    expect(Object.keys(store().layouts)).toHaveLength(3);
    expect(store().layouts[contentLayoutKey(scope)]).toBe(layout());
  });

  it("splits explicitly, deduplicates across panes atomically and merges only explicit view requests", async () => {
    const a = store().open(scope, file, { view: { versionNumber: 2, line: 8, scrollTop: 120, zoom: 1.5 } });
    store().split(scope);
    expect(layout().panes).toEqual([
      { id: "left", tabIds: [], selectedTabId: null },
      { id: "right", tabIds: [a], selectedTabId: a },
    ]);
    store().split(scope);
    const results = await Promise.all([
      Promise.resolve().then(() => store().open(scope, file, { paneId: "left" })),
      Promise.resolve().then(() => store().open(scope, file)),
    ]);
    expect(results).toEqual([a, a]);
    expect(layout().tabs).toHaveLength(1);
    expect(layout().tabs[0].view).toEqual({ versionNumber: 2, line: 8, scrollTop: 120, zoom: 1.5 });
    expect(layout().focusedPaneId).toBe("right");
    expect(layout().panes).toHaveLength(2);
    expect(store().open(scope, file, { paneId: "left", view: { versionNumber: 4, page: 3 } })).toBe(a);
    expect(layout().tabs[0].view).toEqual({ versionNumber: 4, line: 8, page: 3, scrollTop: 120, zoom: 1.5 });
  });

  it("switches panes independently and preserves identity, view and focused selection through moving, sorting and merging", () => {
    const a = store().open(scope, file, { view: { page: 2 } });
    const b = store().open(scope, { kind: "record", id: 8, title: "Note" });
    const c = store().open(scope, { kind: "session", id: "s", title: "Chat" });
    store().split(scope);
    store().select(scope, "left", a);
    expect(layout().panes[1].selectedTabId).toBe(c);
    store().focus(scope, "right");
    store().move(scope, b, "right", 0);
    expect(layout().panes[1].tabIds).toEqual([b, c]);
    store().reorder(scope, "right", c, 0);
    expect(layout().panes[1].tabIds).toEqual([c, b]);
    store().select(scope, "right", c);
    store().setRatio(scope, 0.65);
    store().updateTitle(scope, a, "Renamed");
    store().updateView(scope, a, { scrollTop: 240 });
    store().merge(scope);
    expect(layout().panes).toEqual([{ id: "left", tabIds: [a, c, b], selectedTabId: c }]);
    expect(layout().focusedPaneId).toBe("left");
    expect(layout().tabs.find(tab => tab.id === a)).toEqual({
      id: a, object: { ...file, title: "Renamed" }, view: { page: 2, scrollTop: 240 },
    });
    expect(layout().ratio).toBe(0.65);
  });

  it("retains an empty pane after moving, and restores that explicit split on resume", async () => {
    const a = store().open(scope, file);
    store().split(scope);
    store().move(scope, a, "left");
    expect(layout().panes).toEqual([
      { id: "left", tabIds: [a], selectedTabId: a },
      { id: "right", tabIds: [], selectedTabId: null },
    ]);
    await useProjectContentStore.persist.rehydrate();
    expect(layout().panes).toHaveLength(2);
    store().focus(scope, "right");
    store().merge(scope);
    expect(layout().panes[0].selectedTabId).toBe(a);
  });

  it("keeps the left focused selection when the final right tab closes", () => {
    const a = store().open(scope, file);
    const b = store().open(scope, { kind: "record", id: 8, title: "Note" });
    store().split(scope);
    store().focus(scope, "left");
    store().close(scope, b);
    expect(layout().panes).toEqual([{ id: "left", tabIds: [a], selectedTabId: a }]);
    expect(layout().focusedPaneId).toBe("left");
  });

  it("closes next to the selected tab and merges when the last tab in either pane closes", () => {
    const a = store().open(scope, file);
    const b = store().open(scope, { kind: "record", id: 8, title: "Note" });
    const c = store().open(scope, { kind: "session", id: "s", title: "Chat" });
    store().select(scope, "left", b);
    store().close(scope, b);
    expect(layout().panes[0].selectedTabId).toBe(c);
    store().split(scope);
    store().close(scope, a);
    expect(layout().panes).toEqual([{ id: "left", tabIds: [c], selectedTabId: c }]);
    store().close(scope, c);
    expect(layout().tabs).toEqual([]);
    expect(layout().panes).toEqual([{ id: "left", tabIds: [], selectedTabId: null }]);

    const d = store().open(scope, file);
    store().split(scope);
    store().close(scope, d);
    expect(layout().panes).toEqual([{ id: "left", tabIds: [], selectedTabId: null }]);
  });

  it("rehydrates both pane selections, title, view and ratio, without persisting content or actions", async () => {
    const a = store().open(scope, file, { view: { versionNumber: 3, line: 12, page: 4, zoom: 2, scrollTop: 400, sourceQuery: "sourceTimeMs=2000" } });
    store().split(scope);
    const b = store().open(scope, { kind: "record", id: 8, title: "Note" }, { paneId: "left" });
    store().updateTitle(scope, a, "New title");
    store().setRatio(scope, 0.6);
    const saved = layout();
    const name = useProjectContentStore.persist.getOptions().name!;
    const serialized = window.localStorage.getItem(name)!;
    expect(Object.keys(JSON.parse(serialized).state)).toEqual(["layouts"]);
    // Simulate a new in-memory state without overwriting the saved storage.
    useProjectContentStore.setState({ layouts: {} });
    window.localStorage.setItem(name, serialized);
    await useProjectContentStore.persist.rehydrate();
    expect(layout()).toEqual(saved);
    expect(layout().panes.map(pane => pane.selectedTabId)).toEqual([b, a]);
    expect(store().open(scope, file)).toBe(a);
    expect(layout().tabs[0].view.versionNumber).toBe(3);
    store().updateView(scope, a, { versionNumber: undefined });
    expect(layout().tabs[0].view.versionNumber).toBeUndefined();
  });

  it("refreshes authoritative titles on duplicate open without replacing identity or Record source location", () => {
    const record = { kind: "record", id: 8, title: "Original" } as const;
    const sourceQuery = new URLSearchParams({ sourceBlock: "a".repeat(32), sourceRevision: "4" }).toString();
    const id = store().open(scope, record, { view: { sourceQuery, scrollTop: 200 } });
    expect(store().open(scope, { ...record, title: "Renamed" })).toBe(id);
    expect(layout().tabs[0]).toEqual({ id, object: { ...record, title: "Renamed" }, view: { sourceQuery, scrollTop: 200 } });
    store().open(scope, record, { view: { sourceQuery: "sourceTimeMs=1200.5" } });
    expect(layout().tabs[0].view).toEqual({ sourceQuery: "sourceTimeMs=1200.5", scrollTop: 200 });
    store().updateView(scope, id, { sourceQuery: undefined });
    expect(layout().tabs[0].view.sourceQuery).toBeUndefined();
  });

  it("rejects source query content and invalid locations at the view input boundary", () => {
    for (const sourceQuery of ["body=secret", "sourceBlock=body-text", "sourceTimeMs=-1", `sourceTimeMs=${"1".repeat(513)}`, "sourceTimeMs=2&sourceTimeMs=3"]) {
      expect(() => store().open(scope, file, { view: { sourceQuery } })).toThrow();
    }
    expect(layout().tabs).toEqual([]);
  });

  it("adds voice metadata on duplicate open and preserves it across panes and persistence", async () => {
    const record = { kind: "record", id: 8, title: "Record" } as const;
    const id = store().open(scope, record, { view: { sourceQuery: "sourceTimeMs=1200", scrollTop: 200 } });
    store().split(scope);
    expect(store().open(scope, { ...record, title: "Voice Record", isVoice: true }, { paneId: "left" })).toBe(id);
    expect(store().open(scope, { ...record, title: "Renamed" })).toBe(id);
    const saved = layout();
    expect(saved.tabs).toEqual([{ id, object: { ...record, title: "Renamed", isVoice: true },
      view: { sourceQuery: "sourceTimeMs=1200", scrollTop: 200 } }]);
    expect(saved.focusedPaneId).toBe("right");
    const name = useProjectContentStore.persist.getOptions().name!;
    const serialized = window.localStorage.getItem(name)!;
    expect(JSON.parse(serialized).version).toBe(1);
    useProjectContentStore.setState({ layouts: {} });
    window.localStorage.setItem(name, serialized);
    await useProjectContentStore.persist.rehydrate();
    expect(layout()).toEqual(saved);
    expect(store().open(scope, record)).toBe(id);
    expect(layout().tabs[0].object.isVoice).toBe(true);
  });

  it("stores voice metadata on first open only for Record objects", () => {
    const record = { kind: "record", id: 8, title: "Voice", isVoice: true } as const;
    store().open(scope, record);
    store().open(scope, { ...file, isVoice: true });
    store().open(scope, { kind: "session", id: "session", title: "Chat", isVoice: true });
    store().open(scope, { ...file, isVoice: false });
    expect(layout().tabs.map(tab => tab.object)).toEqual([
      record, file, { kind: "session", id: "session", title: "Chat" },
    ]);
  });

  it.each([
    ["third pane", (value: ProjectContentLayout) => ({ ...value, panes: [...value.panes, { id: "third", tabIds: [], selectedTabId: null }] })],
    ["duplicate object", (value: ProjectContentLayout) => ({ ...value, tabs: [...value.tabs, { ...value.tabs[0], id: "copy" }] })],
    ["duplicate membership", (value: ProjectContentLayout) => ({ ...value, panes: [{ ...value.panes[0], tabIds: [value.tabs[0].id, value.tabs[0].id] }] })],
    ["dangling membership", (value: ProjectContentLayout) => ({ ...value, panes: [{ ...value.panes[0], tabIds: [value.tabs[0].id, "gone"] }] })],
    ["missing membership", (value: ProjectContentLayout) => ({ ...value, panes: [{ ...value.panes[0], tabIds: [], selectedTabId: null }] })],
    ["invalid selection", (value: ProjectContentLayout) => ({ ...value, panes: [{ ...value.panes[0], selectedTabId: "gone" }] })],
    ["missing selection", (value: ProjectContentLayout) => ({ ...value, panes: [{ ...value.panes[0], selectedTabId: null }] })],
    ["invalid focus", (value: ProjectContentLayout) => ({ ...value, focusedPaneId: "right" })],
    ["invalid ratio", (value: ProjectContentLayout) => ({ ...value, ratio: 0 })],
    ["invalid view", (value: ProjectContentLayout) => ({ ...value, tabs: [{ ...value.tabs[0], view: { page: -1 } }] })],
    ["invalid object", (value: ProjectContentLayout) => ({ ...value, tabs: [{ ...value.tabs[0], object: { ...value.tabs[0].object, kind: "path" } }] })],
    ["invalid source query", (value: ProjectContentLayout) => ({ ...value, tabs: [{ ...value.tabs[0], view: { sourceQuery: "body=private" } }] })],
  ])("drops only the corrupt project on resume: %s", async (_reason, corrupt) => {
    const goodScope = { ...scope, projectId: 2 };
    const goodId = store().open(goodScope, { kind: "record", id: 9, title: "Good" });
    store().open(scope, file);
    const saved = JSON.parse(JSON.stringify(store().layouts));
    saved[contentLayoutKey(scope)] = corrupt(saved[contentLayoutKey(scope)]);
    window.localStorage.setItem(useProjectContentStore.persist.getOptions().name!, JSON.stringify({ state: { layouts: saved }, version: 1 }));
    await useProjectContentStore.persist.rehydrate();
    expect(layout().tabs).toEqual([]);
    expect(store().layouts[contentLayoutKey(scope)]).toBeUndefined();
    expect(layout(goodScope).panes[0].selectedTabId).toBe(goodId);
    expect(layout(goodScope).tabs[0].object.title).toBe("Good");
  });

  it("strips unrecognized persisted content and retains unavailable object identities for service resolution", async () => {
    const tabId = store().open(scope, file);
    const saved = JSON.parse(JSON.stringify(store().layouts));
    const tab = saved[contentLayoutKey(scope)].tabs[0];
    tab.object.body = "business content";
    tab.view.secret = "credential";
    tab.connection = "active transport";
    window.localStorage.setItem(useProjectContentStore.persist.getOptions().name!, JSON.stringify({ state: { layouts: saved, open: "malicious" }, version: 1 }));
    await useProjectContentStore.persist.rehydrate();
    expect(layout().tabs).toEqual([{ id: tabId, object: file, view: {} }]);
    expect(typeof store().open).toBe("function");
    store().close(scope, tabId);
    expect(layout().tabs).toEqual([]);
  });

  it("clears one exact workspace without clearing similarly named workspaces", () => {
    store().open(scope, file);
    store().open({ ...scope, projectId: 2 }, file);
    const other = { ...scope, workspaceId: `${scope.workspaceId}:other` };
    const id = store().open(other, file);
    const otherLayout = layout(other);
    useProjectContentStore.setState({ layouts: { ...store().layouts, broken: otherLayout, '["bad"]': otherLayout } });
    store().clearWorkspace(scope.workspaceId);
    expect(Object.keys(store().layouts)).toHaveLength(1);
    expect(layout(other)).toBe(otherLayout);
    expect(layout(other).tabs[0].id).toBe(id);
  });
});
