import { useCallback } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ListPinScope = "projects" | "todos" | "workspace-records" | `project-records:${number}`;
const EMPTY_IDS: readonly number[] = [];

export function recordPinScope(projectId: number | null | undefined): ListPinScope {
  return projectId == null ? "workspace-records" : `project-records:${projectId}`;
}

interface ListPinsState {
  pins: Record<string, readonly number[]>;
  togglePin: (workspaceRoot: string, scope: ListPinScope, id: number) => void;
}

function pinKey(workspaceRoot: string, scope: ListPinScope) {
  return JSON.stringify([workspaceRoot, scope]);
}

export const createListPinsStore = () => create<ListPinsState>()(persist((set) => ({
  pins: {},
  togglePin: (workspaceRoot, scope, id) => set(state => {
    const key = pinKey(workspaceRoot, scope);
    const ids = state.pins[key] ?? EMPTY_IDS;
    return { pins: { ...state.pins, [key]: ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id] } };
  }),
}), {
  name: "project-mind-list-pins", version: 1,
  storage: createJSONStorage(() => window.localStorage),
  partialize: state => ({ pins: state.pins }),
}));

export const useListPinsStore = createListPinsStore();

export function useListPins(workspaceRoot: string, scope: ListPinScope) {
  const pinnedIds = useListPinsStore(state => state.pins[pinKey(workspaceRoot, scope)] ?? EMPTY_IDS);
  const toggle = useListPinsStore(state => state.togglePin);
  const togglePin = useCallback((id: number) => toggle(workspaceRoot, scope, id), [toggle, workspaceRoot, scope]);
  const isPinned = useCallback((id: number) => pinnedIds.includes(id), [pinnedIds]);
  return { pinnedIds, togglePin, isPinned };
}
