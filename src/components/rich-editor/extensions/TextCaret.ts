import { Extension } from "@tiptap/core";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

// WebKit paints wrapped-line carets at line-box height (WebKit bug 287429).
// Keep native editing/selection; draw only its visual bar from the text rectangle.
export const TextCaret = Extension.create({
  name: "textCaret",
  addProseMirrorPlugins() {
    return [new Plugin({ view: installTextCaret })];
  },
});

function installTextCaret(view: EditorView) {
  const root = view.dom;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win || !/AppleWebKit/.test(win.navigator.userAgent)
    || !/Macintosh|iPhone|iPad|iPod/.test(win.navigator.userAgent)
    || /Chrome|Chromium|Edg|OPR|Android/.test(win.navigator.userAgent)) return {};

  const caret = doc.createElement("span");
  caret.className = "rich-editor__text-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.hidden = true;
  doc.body.appendChild(caret);
  let frame = 0;
  let composing = false;
  let destroyed = false;
  const hide = () => {
    root.classList.remove("has-text-caret");
    caret.hidden = true;
  };
  const update = () => {
    frame = 0;
    if (destroyed || !root.isConnected || !view.editable || !view.hasFocus() || !doc.hasFocus()
      || composing || view.composing || !(view.state.selection instanceof TextSelection)
      || !view.state.selection.empty) return hide();
    const selection = doc.getSelection();
    if (!selection?.isCollapsed || !selection.rangeCount || !selection.anchorNode
      || !root.contains(selection.anchorNode)) return hide();
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const coords = view.coordsAtPos(view.state.selection.from);
    const element = selection.anchorNode instanceof Element
      ? selection.anchorNode : selection.anchorNode.parentElement;
    const css = win.getComputedStyle(element ?? root);
    const fontSize = Number.parseFloat(css.fontSize);
    const height = rect.height > 0 ? rect.height
      : Math.min(coords.bottom - coords.top, fontSize * 1.2);
    const left = rect.height > 0 ? rect.left : coords.left;
    const top = rect.height > 0 ? rect.top : coords.top + (coords.bottom - coords.top - height) / 2;
    if (![left, top, height].every(Number.isFinite) || height <= 0
      || top < 0 || top + height > win.innerHeight || left < 0 || left > win.innerWidth) return hide();
    // A body overlay must obey the editor's bounded scroll containers too.
    for (let parent: HTMLElement | null = root; parent && parent !== doc.body; parent = parent.parentElement) {
      const style = win.getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowY)
        && (top < bounds.top || top + height > bounds.bottom)) return hide();
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX)
        && (left < bounds.left || left > bounds.right)) return hide();
    }
    caret.style.left = `${left}px`;
    caret.style.top = `${top}px`;
    caret.style.height = `${height}px`;
    caret.style.backgroundColor = css.color;
    caret.hidden = false;
    root.classList.add("has-text-caret");
  };
  const schedule = () => {
    if (!destroyed && !frame) frame = win.requestAnimationFrame(update);
  };
  const compositionStart = () => { composing = true; hide(); };
  const compositionEnd = () => { composing = false; schedule(); };
  root.addEventListener("focus", schedule);
  root.addEventListener("blur", hide);
  root.addEventListener("compositionstart", compositionStart);
  root.addEventListener("compositionend", compositionEnd);
  doc.addEventListener("selectionchange", schedule);
  doc.addEventListener("scroll", schedule, true);
  win.addEventListener("resize", schedule);
  win.addEventListener("focus", schedule);
  win.addEventListener("blur", hide);
  const resize = new win.ResizeObserver(schedule);
  resize.observe(root);
  doc.fonts?.addEventListener("loadingdone", schedule);
  schedule();
  return {
    update: schedule,
    destroy() {
      destroyed = true;
      win.cancelAnimationFrame(frame);
      resize.disconnect();
      root.removeEventListener("focus", schedule);
      root.removeEventListener("blur", hide);
      root.removeEventListener("compositionstart", compositionStart);
      root.removeEventListener("compositionend", compositionEnd);
      doc.removeEventListener("selectionchange", schedule);
      doc.removeEventListener("scroll", schedule, true);
      win.removeEventListener("resize", schedule);
      win.removeEventListener("focus", schedule);
      win.removeEventListener("blur", hide);
      doc.fonts?.removeEventListener("loadingdone", schedule);
      hide();
      caret.remove();
    },
  };
}
