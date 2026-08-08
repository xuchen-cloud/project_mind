import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface EditorRewriteProtectedRange {
  from: number;
  to: number;
}

type EditorRewriteProtectionMeta =
  | { type: "set"; key: string; range: EditorRewriteProtectedRange }
  | { type: "remove"; key: string }
  | { type: "clear" };

type EditorRewriteProtectedRanges = Record<string, EditorRewriteProtectedRange>;

export const EDITOR_REWRITE_PROTECTION_PLUGIN_KEY = new PluginKey<EditorRewriteProtectedRanges>(
  "project-mind-editor-rewrite-protection",
);

const EDITOR_REWRITE_INTERNAL_TRANSACTION_META =
  "project-mind-editor-rewrite-internal-transaction";

export function createEditorRewriteProtectionPlugin(options?: {
  onBlocked?: () => void;
}) {
  let blockedNoticeQueued = false;
  let lastBlockedNoticeAt = 0;

  const notifyBlocked = () => {
    const now = Date.now();
    if (
      blockedNoticeQueued ||
      now - lastBlockedNoticeAt < 1200 ||
      !options?.onBlocked
    ) {
      return;
    }
    lastBlockedNoticeAt = now;
    blockedNoticeQueued = true;
    queueMicrotask(() => {
      blockedNoticeQueued = false;
      options.onBlocked?.();
    });
  };

  return new Plugin<EditorRewriteProtectedRanges>({
    key: EDITOR_REWRITE_PROTECTION_PLUGIN_KEY,
    state: {
      init: () => ({}),
      apply(transaction, protectedRanges) {
        const meta = transaction.getMeta(
          EDITOR_REWRITE_PROTECTION_PLUGIN_KEY,
        ) as EditorRewriteProtectionMeta | undefined;

        if (meta?.type === "set") {
          const range = normalizeProtectedRange(transaction.doc, meta.range);
          if (!range) return protectedRanges;
          return { ...protectedRanges, [meta.key ?? "active"]: range };
        }
        if (meta?.type === "remove") {
          const next = { ...protectedRanges };
          delete next[meta.key];
          return next;
        }
        if (meta?.type === "clear") {
          return {};
        }
        if (!transaction.docChanged) {
          return protectedRanges;
        }
        return Object.fromEntries(Object.entries(protectedRanges).flatMap(([key, range]) => {
          const mapped = normalizeProtectedRange(transaction.doc, {
            from: transaction.mapping.map(range.from, 1),
            to: transaction.mapping.map(range.to, -1),
          });
          return mapped ? [[key, mapped]] : [];
        }));
      },
    },
    filterTransaction(transaction, state) {
      const protectedRanges = Object.values(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(state) ?? {});
      if (
        protectedRanges.length === 0 ||
        !transaction.docChanged ||
        transaction.getMeta(EDITOR_REWRITE_INTERNAL_TRANSACTION_META)
      ) {
        return true;
      }

      if (protectedRanges.every((range) => transactionPreservesProtectedRange(transaction, state.doc, range))) {
        return true;
      }

      notifyBlocked();
      return false;
    },
    props: {
      decorations(state) {
        const protectedRanges = Object.values(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(state) ?? {});
        if (protectedRanges.length === 0) {
          return null;
        }

        const decorations: Decoration[] = [];
        state.doc.forEach((node, offset) => {
          const nodeTo = offset + node.nodeSize;
          if (protectedRanges.some((range) => offset < range.to && nodeTo > range.from)) {
            decorations.push(
              Decoration.node(offset, nodeTo, {
                class: "rich-editor__rewrite-protected-block",
                "data-ai-rewrite-protected": "true",
              }),
            );
          }
        });

        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

export function getEditorRewriteProtectedRange(
  editor: Editor,
  key?: string,
): EditorRewriteProtectedRange | null {
  const ranges = EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(editor.state) ?? {};
  return key ? ranges[key] ?? null : Object.values(ranges)[0] ?? null;
}

export function setEditorRewriteProtectedRange(
  editor: Editor,
  range: EditorRewriteProtectedRange | null,
  key?: string,
) {
  const meta: EditorRewriteProtectionMeta = range
    ? { type: "set", key: key ?? "active", range }
    : key ? { type: "remove", key } : { type: "clear" };
  editor.view.dispatch(
    editor.state.tr.setMeta(EDITOR_REWRITE_PROTECTION_PLUGIN_KEY, meta),
  );
}

export function markEditorRewriteTransaction(transaction: Transaction) {
  return transaction.setMeta(EDITOR_REWRITE_INTERNAL_TRANSACTION_META, true);
}

export function transactionPreservesProtectedRange(
  transaction: Transaction,
  currentDoc: ProseMirrorNode,
  protectedRange: EditorRewriteProtectedRange,
) {
  const mappedFrom = transaction.mapping.map(protectedRange.from, 1);
  const mappedTo = transaction.mapping.map(protectedRange.to, -1);

  if (
    mappedFrom < 0 ||
    mappedTo <= mappedFrom ||
    mappedTo > transaction.doc.content.size
  ) {
    return false;
  }

  return currentDoc
    .slice(protectedRange.from, protectedRange.to)
    .eq(transaction.doc.slice(mappedFrom, mappedTo));
}

function normalizeProtectedRange(
  doc: ProseMirrorNode,
  range: EditorRewriteProtectedRange,
): EditorRewriteProtectedRange | null {
  if (
    range.from < 0 ||
    range.to <= range.from ||
    range.to > doc.content.size
  ) {
    return null;
  }

  return range;
}
