import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";

// prosemirror-view 1.42.6 has no public API for synchronizing browser edits.
// forceFlush clears flushSoon's timer; flush also consumes blur's queued records.
// Keep this pinned internal dependency here, outside serialization/update hooks.
type ObservedView = EditorView & { domObserver: { forceFlush(): void; flush(): void } };

export function flushPendingEditorDom(editor: Editor): boolean {
  if (editor.isDestroyed) {
    deferredFreezes.get(editor)?.();
    return false;
  }
  if (editor.view.composing) return false;
  const { domObserver } = editor.view as ObservedView;
  domObserver.forceFlush();
  domObserver.flush();
  return true;
}

const deferredFreezes = new WeakMap<Editor, () => void>();

export function setEditablePreservingPendingDom(editor: Editor, editable: boolean): void {
  deferredFreezes.get(editor)?.();
  if (editor.isDestroyed) return;
  if (editable) {
    editor.setEditable(true);
    return;
  }
  if (flushPendingEditorDom(editor)) {
    editor.setEditable(false);
    return;
  }
  // A hold/readonly effect must not throw or force IME completion. Its caller
  // blocks interaction; saving fails closed until the real composition ends.
  const dom = editor.view.dom;
  const cancel = () => {
    dom.removeEventListener("compositionend", finish);
    deferredFreezes.delete(editor);
  };
  const finish = () => {
    queueMicrotask(() => {
      if (deferredFreezes.get(editor) !== cancel) return;
      cancel();
      if (!editor.isDestroyed && flushPendingEditorDom(editor)) editor.setEditable(false);
    });
  };
  deferredFreezes.set(editor, cancel);
  dom.addEventListener("compositionend", finish);
}
