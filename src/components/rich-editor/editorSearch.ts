import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface EditorSearchMatch {
  from: number;
  to: number;
}

export const RICH_EDITOR_SEARCH_PLUGIN_KEY = new PluginKey(
  "project-mind-rich-editor-search",
);

export function findEditorSearchMatches(editor: Editor, query: string): EditorSearchMatch[] {
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLocaleLowerCase("zh-Hans-CN");
  if (!normalizedQuery) return [];

  const matches: EditorSearchMatch[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;

    const normalizedText = node.text.toLocaleLowerCase("zh-Hans-CN");
    let index = normalizedText.indexOf(normalizedQuery);
    while (index !== -1) {
      matches.push({ from: pos + index, to: pos + index + trimmedQuery.length });
      index = normalizedText.indexOf(normalizedQuery, index + Math.max(1, normalizedQuery.length));
    }
    return true;
  });
  return matches;
}

export function editorSearchMatchesEqual(
  left: EditorSearchMatch[],
  right: EditorSearchMatch[],
) {
  return (
    left.length === right.length &&
    left.every((match, index) => {
      const other = right[index];
      return other && match.from === other.from && match.to === other.to;
    })
  );
}

export function scrollSearchMatchIntoComfortView(editor: Editor, position: number) {
  if (editor.isDestroyed) return;

  let coords: { top: number; bottom: number };
  try {
    coords = editor.view.coordsAtPos(position);
  } catch {
    return;
  }

  const scrollParent = findScrollableParent(editor.view.dom);
  const matchMiddle = (coords.top + coords.bottom) / 2;
  if (scrollParent) {
    const rect = scrollParent.getBoundingClientRect();
    const comfortTop = rect.top + rect.height * 0.28;
    const comfortBottom = rect.top + rect.height * 0.72;
    if (matchMiddle < comfortTop || matchMiddle > comfortBottom) {
      scrollParent.scrollBy({
        top: matchMiddle - (rect.top + rect.height * 0.42),
        behavior: "smooth",
      });
    }
    return;
  }

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  if (matchMiddle < viewportHeight * 0.28 || matchMiddle > viewportHeight * 0.72) {
    window.scrollBy({ top: matchMiddle - viewportHeight * 0.42, behavior: "smooth" });
  }
}

function findScrollableParent(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const style = window.getComputedStyle(parent);
    const canScroll =
      /(auto|scroll|overlay)/u.test(style.overflowY) ||
      /(auto|scroll|overlay)/u.test(style.overflow);
    if (canScroll && parent.scrollHeight > parent.clientHeight) return parent;
    parent = parent.parentElement;
  }
  return null;
}

export function createEditorSearchPlugin(options: {
  getSearchState: () => {
    open: boolean;
    matches: EditorSearchMatch[];
    activeIndex: number;
  };
}) {
  return new Plugin({
    key: RICH_EDITOR_SEARCH_PLUGIN_KEY,
    state: {
      init: () => 0,
      apply(tr, value) {
        return tr.getMeta(RICH_EDITOR_SEARCH_PLUGIN_KEY) ?? value;
      },
    },
    props: {
      decorations(state) {
        const search = options.getSearchState();
        if (!search.open || search.matches.length === 0) return null;

        const decorations = search.matches
          .filter((match) => match.from >= 0 && match.to <= state.doc.content.size && match.from < match.to)
          .map((match, index) =>
            Decoration.inline(match.from, match.to, {
              class:
                index === search.activeIndex
                  ? "rich-editor__search-match rich-editor__search-match--active"
                  : "rich-editor__search-match",
            }),
          );
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}
