import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

export type FileSelectionItem = {
  key: string;
  relativePath: string;
  kind: "file" | "directory";
  fileId?: number;
};

export function fileSelectionData(item: FileSelectionItem) {
  return {
    "data-file-selection-key": item.key,
    "data-file-selection-path": item.relativePath,
    "data-file-selection-kind": item.kind,
    "data-file-selection-id": item.fileId,
  };
}

/** Read rendered rows, including expanded descendants, in visual DOM order. */
function visibleItems(root: HTMLElement | null): FileSelectionItem[] {
  if (!root) return [];
  const visibility = new Map<HTMLElement, boolean>();
  const visible = (node: HTMLElement): boolean => {
    const cached = visibility.get(node);
    if (cached !== undefined) return cached;
    const style = getComputedStyle(node);
    const result = !node.hidden && !node.hasAttribute("inert") && node.getAttribute("aria-hidden") !== "true"
      && style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse"
      && (!node.parentElement || visible(node.parentElement));
    visibility.set(node, result);
    return result;
  };
  return Array.from(root.querySelectorAll<HTMLElement>("[data-file-selection-key]"))
    .filter(visible).map(node => ({
      key: node.dataset.fileSelectionKey!,
      relativePath: node.dataset.fileSelectionPath!,
      kind: node.dataset.fileSelectionKind as FileSelectionItem["kind"],
      ...(node.dataset.fileSelectionId === undefined ? {} : { fileId: Number(node.dataset.fileSelectionId) }),
    }));
}

type ClickModifiers = {
  shiftKey: boolean; ctrlKey: boolean; metaKey: boolean;
  target?: EventTarget | null; currentTarget?: EventTarget | null;
};
type MouseModifiers = ClickModifiers & { button: number };
function isInteractiveDescendant(event: ClickModifiers): boolean {
  if (!(event.target instanceof Element) || !(event.currentTarget instanceof Element)) return false;
  const control = event.target.closest("button, input, textarea, select, a, [contenteditable]:not([contenteditable=false]), [role=button]");
  return !!control && control !== event.currentTarget && event.currentTarget.contains(control);
}
type SelectionState = {
  scope: string;
  selected: ReadonlySet<string>;
  anchor?: string;
  rangeBase?: ReadonlySet<string>;
  rangeUnion?: boolean;
};
const emptySelection: ReadonlySet<string> = new Set();

export function useFileSelection(scope: string, root: RefObject<HTMLElement | null>) {
  const state = useRef<SelectionState>({ scope, selected: emptySelection });
  const [snapshot, setSnapshot] = useState(state.current);
  const controlPrimary = useRef<{ key: string; consumed: boolean } | undefined>(undefined);
  const update = useCallback((next: SelectionState) => {
    state.current = next;
    setSnapshot(next);
  }, []);
  const prune = useCallback(() => {
    const items = visibleItems(root.current);
    if (state.current.scope !== scope) return items;
    const keys = new Set(items.map(item => item.key));
    const previous = state.current;
    const selected = new Set([...previous.selected].filter(key => keys.has(key)));
    const anchor = previous.anchor && keys.has(previous.anchor) ? previous.anchor : undefined;
    const rangeBase = previous.rangeBase && new Set([...previous.rangeBase].filter(key => keys.has(key)));
    if (selected.size !== previous.selected.size || anchor !== previous.anchor || rangeBase?.size !== previous.rangeBase?.size) {
      update({ ...previous, selected, anchor, rangeBase });
    }
    return items;
  }, [root, scope, update]);
  useLayoutEffect(() => {
    update({ scope, selected: emptySelection });
    controlPrimary.current = undefined;
    const observer = new MutationObserver(prune);
    if (root.current) observer.observe(root.current, { childList: true, subtree: true, attributes: true,
      attributeFilter: ["hidden", "inert", "aria-hidden", "style", "class", "data-file-selection-key", "data-file-selection-path", "data-file-selection-kind", "data-file-selection-id"] });
    for (let node = root.current?.parentElement; node; node = node.parentElement) {
      observer.observe(node, { attributes: true, attributeFilter: ["hidden", "inert", "aria-hidden", "style", "class"] });
    }
    return () => {
      observer.disconnect();
      controlPrimary.current = undefined;
      state.current = { scope, selected: emptySelection };
    };
  }, [scope, root, prune, update]);

  const onClick = useCallback((item: FileSelectionItem, event: ClickModifiers): boolean => {
    // Row controls keep their own editing, menu and link behavior.
    if (isInteractiveDescendant(event)) return false;
    const consumed = controlPrimary.current?.key === item.key && controlPrimary.current.consumed;
    controlPrimary.current = undefined;
    if (consumed) return true;
    const items = prune();
    if (state.current.scope !== scope || !items.some(row => row.key === item.key)) return false;
    const previous = state.current;
    const toggle = event.ctrlKey || event.metaKey;
    if (event.shiftKey) {
      const anchor = previous.anchor ?? item.key;
      const start = items.findIndex(row => row.key === anchor);
      const end = items.findIndex(row => row.key === item.key);
      const rangeBase = previous.rangeBase && previous.rangeUnion === toggle
        ? previous.rangeBase : toggle ? previous.selected : emptySelection;
      const selected = new Set(rangeBase);
      for (const row of items.slice(Math.min(start, end), Math.max(start, end) + 1)) selected.add(row.key);
      update({ scope, selected, anchor, rangeBase, rangeUnion: toggle });
    } else if (toggle) {
      const selected = new Set(previous.selected);
      if (selected.has(item.key)) selected.delete(item.key); else selected.add(item.key);
      update({ scope, selected, anchor: item.key });
    } else update({ scope, selected: new Set([item.key]), anchor: item.key });
    return event.shiftKey || toggle;
  }, [scope, prune, update]);

  const onMouseDown = useCallback((item: FileSelectionItem, event: MouseModifiers) => {
    controlPrimary.current = !isInteractiveDescendant(event) && event.button === 0 && event.ctrlKey ? { key: item.key, consumed: false } : undefined;
  }, []);
  const onContextMenu = useCallback((item: FileSelectionItem, event?: MouseModifiers): FileSelectionItem[] | undefined => {
    if (event && isInteractiveDescendant(event)) return undefined;
    // WebKit can translate Control + primary click into a contextmenu event.
    // The preceding mousedown distinguishes it from a real secondary click.
    if (event?.ctrlKey && controlPrimary.current?.key === item.key) {
      if (!controlPrimary.current.consumed) onClick(item, event);
      controlPrimary.current = { key: item.key, consumed: true };
      return undefined;
    }
    const items = prune();
    if (state.current.scope !== scope || !items.some(row => row.key === item.key)) return [];
    if (!state.current.selected.has(item.key)) update({ scope, selected: new Set([item.key]), anchor: item.key });
    return items.filter(row => state.current.selected.has(row.key));
  }, [scope, prune, update, onClick]);
  const remove = useCallback((paths: readonly string[]) => {
    const items = prune();
    if (state.current.scope !== scope) return;
    const removed = new Set(items.filter(item => paths.some(path => item.relativePath === path || item.relativePath.startsWith(`${path}/`))).map(item => item.key));
    const previous = state.current;
    update({ scope, selected: new Set([...previous.selected].filter(key => !removed.has(key))),
      anchor: previous.anchor && !removed.has(previous.anchor) ? previous.anchor : undefined });
  }, [scope, prune, update]);
  const clear = useCallback(() => {
    if (state.current.scope === scope) update({ scope, selected: emptySelection });
  }, [scope, update]);
  return { selected: snapshot.scope === scope ? snapshot.selected : emptySelection, onMouseDown, onClick, onContextMenu, remove, clear };
}
