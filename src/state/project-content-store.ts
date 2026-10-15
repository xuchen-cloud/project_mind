import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  contentLayoutKey, contentLayoutWorkspaceId, emptyContentLayout, sanitizeContentLayouts, sanitizeContentView,
  type ContentObject, type ContentPane, type ContentScope, type ContentView, type ProjectContentLayout,
} from "../lib/project-content-layout";

type PaneId = ContentPane["id"];
export interface ProjectContentState {
  layouts: Record<string, ProjectContentLayout>;
  open: (scope: ContentScope, object: ContentObject, options?: { paneId?: PaneId; view?: ContentView }) => string;
  select: (scope: ContentScope, paneId: PaneId, tabId: string) => void;
  selectHome: (scope: ContentScope) => void;
  focus: (scope: ContentScope, paneId: PaneId) => void;
  split: (scope: ContentScope) => void;
  move: (scope: ContentScope, tabId: string, paneId: PaneId, index?: number) => void;
  reorder: (scope: ContentScope, paneId: PaneId, tabId: string, index: number) => void;
  merge: (scope: ContentScope) => void;
  close: (scope: ContentScope, tabId: string) => void;
  setRatio: (scope: ContentScope, ratio: number) => void;
  updateView: (scope: ContentScope, tabId: string, partialView: ContentView) => void;
  updateTitle: (scope: ContentScope, tabId: string, title: string) => void;
  clearWorkspace: (workspaceId: string) => void;
}

function removeFromPane(pane: ContentPane, tabId: string) {
  const index = pane.tabIds.indexOf(tabId);
  pane.tabIds.splice(index, 1);
  if (pane.selectedTabId === tabId) pane.selectedTabId = pane.tabIds[index] ?? pane.tabIds[index - 1] ?? null;
}

function mergePanes(layout: ProjectContentLayout) {
  const focused = layout.panes.find(pane => pane.id === layout.focusedPaneId)!;
  const tabIds = layout.panes.flatMap(pane => pane.tabIds);
  const selectedTabId = focused.id === "left" ? focused.selectedTabId
    : focused.selectedTabId ?? layout.panes[0].selectedTabId;
  layout.panes = [{ id: "left", tabIds, selectedTabId }];
  layout.focusedPaneId = "left";
}

function insertIndex(index: number | undefined, length: number) {
  return index === undefined || !Number.isFinite(index) ? length : Math.max(0, Math.min(length, Math.trunc(index)));
}

export const useProjectContentStore = create<ProjectContentState>()(persist((set) => {
  function edit(scope: ContentScope, change: (layout: ProjectContentLayout) => void) {
    set(state => {
      const key = contentLayoutKey(scope);
      const previous = state.layouts[key] ?? emptyContentLayout();
      const layout = {
        ...previous, tabs: [...previous.tabs],
        panes: previous.panes.map(pane => ({ ...pane, tabIds: [...pane.tabIds] })),
      };
      change(layout);
      return { layouts: { ...state.layouts, [key]: layout } };
    });
  }
  return {
    layouts: {},
    // Authority is checked by the service before entering this synchronous boundary.
    open: (scope, object, options) => {
      const view = options?.view === undefined ? undefined : sanitizeContentView(options.view);
      if (view === null) throw new Error("Invalid project content view");
      const presentation: ContentObject = { kind: object.kind, id: object.id, title: object.title };
      if (object.kind === "record" && typeof object.isVoice === "boolean") presentation.isVoice = object.isVoice;
      let tabId = "";
      set(state => {
        const key = contentLayoutKey(scope);
        const previous = state.layouts[key] ?? emptyContentLayout();
        const existing = previous.tabs.find(tab => tab.object.kind === object.kind && tab.object.id === object.id);
        tabId = existing?.id ?? crypto.randomUUID();
        const pane = existing
          ? previous.panes.find(candidate => candidate.tabIds.includes(tabId))!
          : previous.panes.find(candidate => candidate.id === (options?.paneId ?? previous.focusedPaneId)) ?? previous.panes[0];
        const tabs = existing
          ? previous.tabs.map(tab => tab.id === tabId ? { ...tab, object: { ...tab.object, ...presentation }, view: view ? { ...tab.view, ...view } : tab.view } : tab)
          : [...previous.tabs, { id: tabId, object: presentation, view: { ...view } }];
        return { layouts: { ...state.layouts, [key]: {
          ...previous, tabs, focusedPaneId: pane.id,
          panes: previous.panes.map(candidate => candidate.id === pane.id
            ? { ...candidate, tabIds: existing ? candidate.tabIds : [...candidate.tabIds, tabId], selectedTabId: tabId }
            : candidate),
        } } };
      });
      return tabId;
    },
    select: (scope, paneId, tabId) => edit(scope, layout => {
      const pane = layout.panes.find(candidate => candidate.id === paneId);
      if (!pane?.tabIds.includes(tabId)) return;
      pane.selectedTabId = tabId;
      layout.focusedPaneId = paneId;
    }),
    selectHome: scope => edit(scope, layout => {
      layout.panes[0].selectedTabId = null;
      layout.focusedPaneId = "left";
    }),
    focus: (scope, paneId) => edit(scope, layout => {
      if (layout.panes.some(pane => pane.id === paneId)) layout.focusedPaneId = paneId;
    }),
    split: scope => edit(scope, layout => {
      if (layout.panes.length === 2) return;
      const left = layout.panes[0];
      const tabId = left.selectedTabId;
      if (tabId !== null) removeFromPane(left, tabId);
      layout.panes.push({ id: "right", tabIds: tabId === null ? [] : [tabId], selectedTabId: tabId });
      layout.focusedPaneId = "right";
    }),
    move: (scope, tabId, paneId, index) => edit(scope, layout => {
      const source = layout.panes.find(pane => pane.tabIds.includes(tabId));
      const target = layout.panes.find(pane => pane.id === paneId);
      if (!source || !target) return;
      removeFromPane(source, tabId);
      target.tabIds.splice(insertIndex(index, target.tabIds.length), 0, tabId);
      target.selectedTabId = tabId;
      layout.focusedPaneId = paneId;
    }),
    reorder: (scope, paneId, tabId, index) => edit(scope, layout => {
      const pane = layout.panes.find(candidate => candidate.id === paneId);
      if (!pane?.tabIds.includes(tabId)) return;
      pane.tabIds.splice(pane.tabIds.indexOf(tabId), 1);
      pane.tabIds.splice(insertIndex(index, pane.tabIds.length), 0, tabId);
    }),
    merge: scope => edit(scope, mergePanes),
    close: (scope, tabId) => edit(scope, layout => {
      const pane = layout.panes.find(candidate => candidate.tabIds.includes(tabId));
      if (!pane) return;
      removeFromPane(pane, tabId);
      layout.tabs = layout.tabs.filter(tab => tab.id !== tabId);
      if (layout.panes.length === 2 && pane.id === "right" && pane.tabIds.length === 0) mergePanes(layout);
    }),
    setRatio: (scope, ratio) => edit(scope, layout => {
      // The shell constrains physical minimum widths; the model stores a valid proportion.
      if (Number.isFinite(ratio) && ratio > 0 && ratio < 1) layout.ratio = ratio;
    }),
    updateView: (scope, tabId, partialView) => {
      const view = sanitizeContentView(partialView);
      if (view === null) throw new Error("Invalid project content view");
      edit(scope, layout => {
        layout.tabs = layout.tabs.map(tab => tab.id === tabId ? { ...tab, view: { ...tab.view, ...view } } : tab);
      });
    },
    updateTitle: (scope, tabId, title) => edit(scope, layout => {
      layout.tabs = layout.tabs.map(tab => tab.id === tabId ? { ...tab, object: { ...tab.object, title } } : tab);
    }),
    clearWorkspace: workspaceId => set(state => ({
      layouts: Object.fromEntries(Object.entries(state.layouts).filter(([key]) => {
        const owner = contentLayoutWorkspaceId(key);
        return owner !== null && owner !== workspaceId;
      })),
    })),
  };
}, {
  name: "project-mind-project-content-layouts", version: 1,
  storage: createJSONStorage(() => window.localStorage),
  partialize: state => ({ layouts: state.layouts }),
  merge: (persisted, current) => ({
    ...current,
    layouts: sanitizeContentLayouts(typeof persisted === "object" && persisted !== null && "layouts" in persisted ? persisted.layouts : undefined),
  }),
}));
