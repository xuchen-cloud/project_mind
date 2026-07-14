import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface EditorRewriteProtectedRange {
  from: number;
  to: number;
}

type EditorRewriteProtectionMeta =
  | { type: "set"; range: EditorRewriteProtectedRange }
  | { type: "clear" };

export const EDITOR_REWRITE_PROTECTION_PLUGIN_KEY = new PluginKey<EditorRewriteProtectedRange | null>(
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

  return new Plugin<EditorRewriteProtectedRange | null>({
    key: EDITOR_REWRITE_PROTECTION_PLUGIN_KEY,
    state: {
      init: () => null,
      apply(transaction, protectedRange) {
        const meta = transaction.getMeta(
          EDITOR_REWRITE_PROTECTION_PLUGIN_KEY,
        ) as EditorRewriteProtectionMeta | undefined;

        if (meta?.type === "set") {
          return normalizeProtectedRange(transaction.doc, meta.range);
        }
        if (meta?.type === "clear") {
          return null;
        }
        if (!protectedRange || !transaction.docChanged) {
          return protectedRange;
        }

        return normalizeProtectedRange(transaction.doc, {
          from: transaction.mapping.map(protectedRange.from, 1),
          to: transaction.mapping.map(protectedRange.to, -1),
        });
      },
    },
    filterTransaction(transaction, state) {
      const protectedRange = EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(state);
      if (
        !protectedRange ||
        !transaction.docChanged ||
        transaction.getMeta(EDITOR_REWRITE_INTERNAL_TRANSACTION_META)
      ) {
        return true;
      }

      if (transactionPreservesProtectedRange(transaction, state.doc, protectedRange)) {
        return true;
      }

      notifyBlocked();
      return false;
    },
    props: {
      decorations(state) {
        const protectedRange = EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(state);
        if (!protectedRange) {
          return null;
        }

        const decorations: Decoration[] = [];
        state.doc.forEach((node, offset) => {
          const nodeTo = offset + node.nodeSize;
          if (offset < protectedRange.to && nodeTo > protectedRange.from) {
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
): EditorRewriteProtectedRange | null {
  return EDITOR_REWRITE_PROTECTION_PLUGIN_KEY.getState(editor.state) ?? null;
}

export function setEditorRewriteProtectedRange(
  editor: Editor,
  range: EditorRewriteProtectedRange | null,
) {
  const meta: EditorRewriteProtectionMeta = range
    ? { type: "set", range }
    : { type: "clear" };
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
