import { parseSourceNavigation } from "./source-navigation";
import type { AgentSourceRef } from "./agent-types";

export type ContentScope = { workspaceId: string; projectId: number };
export type ContentObject = { kind: "record" | "file" | "session"; id: number | string; title: string; isVoice?: boolean };
export type ContentView = { versionNumber?: number; line?: number; page?: number; scrollTop?: number; zoom?: number; sourceQuery?: string;
  sourceLocator?: NonNullable<AgentSourceRef["locator"]>;
  sourceMode?: boolean;
  fileViews?: Record<string, { scrollTop?: number; zoom?: number }> };
export type ContentTab = { id: string; object: ContentObject; view: ContentView };
export type ContentPane = { id: "left" | "right"; tabIds: string[]; selectedTabId: string | null };
export type ProjectContentLayout = { tabs: ContentTab[]; panes: ContentPane[]; focusedPaneId: "left" | "right"; ratio: number };

export function contentLayoutKey(scope: ContentScope): string {
  return JSON.stringify([scope.workspaceId, scope.projectId]);
}

export function emptyContentLayout(): ProjectContentLayout {
  return { tabs: [], panes: [{ id: "left", tabIds: [], selectedTabId: null }], focusedPaneId: "left", ratio: 0.5 };
}

// Missing projects must not return a fresh selector value on every render.
const EMPTY_LAYOUT = emptyContentLayout();
Object.freeze(EMPTY_LAYOUT.tabs);
Object.freeze(EMPTY_LAYOUT.panes[0].tabIds);
Object.freeze(EMPTY_LAYOUT.panes[0]);
Object.freeze(EMPTY_LAYOUT.panes);
Object.freeze(EMPTY_LAYOUT);

export function getContentLayout(state: { layouts: Record<string, ProjectContentLayout> }, scope: ContentScope): ProjectContentLayout {
  return state.layouts[contentLayoutKey(scope)] ?? EMPTY_LAYOUT;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whitelist view metadata at the input/storage boundary, never business content. */
export function sanitizeContentView(value: unknown): ContentView | null {
  if (!isObject(value)) return null;
  const view: ContentView = {};
  if (Object.prototype.hasOwnProperty.call(value, "sourceMode")) {
    if (value.sourceMode !== undefined && typeof value.sourceMode !== "boolean") return null;
    view.sourceMode = value.sourceMode as boolean | undefined;
  }
  if (Object.prototype.hasOwnProperty.call(value, "sourceLocator")) {
    const locator = value.sourceLocator;
    if (locator === undefined) view.sourceLocator = undefined;
    else {
      if (!isObject(locator) || !["line", "paragraph", "page"].includes(String(locator.kind))) return null;
      const { start, end, page } = locator;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < (locator.kind === "page" ? 0 : 1)
        || Number(end) < Number(start) || Number(end) > 4294967295) return null;
      if (locator.kind === "page") {
        if (!Number.isSafeInteger(page) || Number(page) <= 0 || Number(page) > 4294967295 || Number(end) === Number(start)) return null;
        view.sourceLocator = { kind: "page", page: Number(page), start: Number(start), end: Number(end) };
      } else view.sourceLocator = { kind: locator.kind as "line" | "paragraph", start: Number(start), end: Number(end) };
    }
  }
  for (const key of ["versionNumber", "line", "page", "scrollTop", "zoom"] as const) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const number = value[key];
    if (number === undefined) { view[key] = undefined; continue; }
    if (typeof number !== "number" || !Number.isFinite(number)) return null;
    if (key === "scrollTop" || key === "zoom" ? number < 0 : number <= 0) return null;
    if (key !== "scrollTop" && key !== "zoom" && !Number.isSafeInteger(number)) return null;
    view[key] = number;
  }
  if (value.fileViews !== undefined) {
    if (!isObject(value.fileViews)) return null;
    const versions: NonNullable<ContentView["fileViews"]> = {};
    for (const [key, candidate] of Object.entries(value.fileViews)) {
      if (!/^[1-9]\d*$/u.test(key) || !Number.isSafeInteger(Number(key)) || !isObject(candidate)) return null;
      const position = sanitizeContentView({ scrollTop: candidate.scrollTop, zoom: candidate.zoom });
      if (!position) return null;
      versions[key] = { scrollTop: position.scrollTop, zoom: position.zoom };
    }
    view.fileViews = versions;
  }
  if (Object.prototype.hasOwnProperty.call(value, "sourceQuery")) {
    const query = value.sourceQuery;
    if (query !== undefined) {
      if (typeof query !== "string" || query.length > 512) return null;
      const params = new URLSearchParams(query);
      const keys = [...params.keys()];
      if (keys.some(key => !["sourceBlock", "sourceRevision", "sourceTimeMs"].includes(key))
        || new Set(keys).size !== keys.length || parseSourceNavigation(params).error) return null;
    }
    view.sourceQuery = query;
  }
  return view;
}

export function contentLayoutWorkspaceId(key: string): string | null {
  try {
    const scope: unknown = JSON.parse(key);
    if (!Array.isArray(scope) || scope.length !== 2 || typeof scope[0] !== "string"
      || !scope[0] || !Number.isSafeInteger(scope[1]) || scope[1] <= 0) return null;
    return contentLayoutKey({ workspaceId: scope[0], projectId: scope[1] }) === key ? scope[0] : null;
  } catch { return null; }
}

function sanitizeLayout(value: unknown): ProjectContentLayout | null {
  if (!isObject(value) || !Array.isArray(value.tabs) || !Array.isArray(value.panes)
    || value.panes.length < 1 || value.panes.length > 2
    || typeof value.ratio !== "number" || !Number.isFinite(value.ratio) || value.ratio <= 0 || value.ratio >= 1) return null;
  const tabs: ContentTab[] = [];
  const tabIds = new Set<string>();
  const objectIds = new Set<string>();
  for (const tab of value.tabs) {
    if (!isObject(tab) || typeof tab.id !== "string" || !tab.id || tabIds.has(tab.id) || !isObject(tab.object)) return null;
    const { kind, id, title } = tab.object;
    if ((kind !== "record" && kind !== "file" && kind !== "session") || typeof title !== "string"
      || (typeof id !== "string" && typeof id !== "number")) return null;
    if (kind === "session" ? typeof id !== "string" : typeof id !== "number") return null;
    if (typeof id === "string" ? !id : !Number.isSafeInteger(id) || id <= 0) return null;
    const objectKey = JSON.stringify([kind, id]);
    const view = sanitizeContentView(tab.view);
    if (objectIds.has(objectKey) || view === null) return null;
    tabIds.add(tab.id);
    objectIds.add(objectKey);
    const object: ContentObject = { kind, id, title };
    if (kind === "record" && typeof tab.object.isVoice === "boolean") object.isVoice = tab.object.isVoice;
    tabs.push({ id: tab.id, object, view });
  }
  const members = new Set<string>();
  const panes: ContentPane[] = [];
  for (const [index, pane] of value.panes.entries()) {
    if (!isObject(pane) || pane.id !== (index === 0 ? "left" : "right") || !Array.isArray(pane.tabIds)) return null;
    const ids: string[] = [];
    for (const id of pane.tabIds) {
      if (typeof id !== "string" || !tabIds.has(id) || members.has(id)) return null;
      members.add(id);
      ids.push(id);
    }
    if (ids.length === 0 ? pane.selectedTabId !== null : typeof pane.selectedTabId !== "string" || !ids.includes(pane.selectedTabId)) return null;
    panes.push({ id: index === 0 ? "left" : "right", tabIds: ids, selectedTabId: pane.selectedTabId as string | null });
  }
  if (members.size !== tabs.length || (value.focusedPaneId !== "left" && value.focusedPaneId !== "right")
    || !panes.some(pane => pane.id === value.focusedPaneId)) return null;
  return { tabs, panes, focusedPaneId: value.focusedPaneId, ratio: value.ratio };
}

/** Invalid projects are discarded independently; no object availability/authority is inferred. */
export function sanitizeContentLayouts(value: unknown): Record<string, ProjectContentLayout> {
  if (!isObject(value)) return {};
  const layouts: Record<string, ProjectContentLayout> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (contentLayoutWorkspaceId(key) === null) continue;
    const layout = sanitizeLayout(candidate);
    if (layout) layouts[key] = layout;
  }
  return layouts;
}
