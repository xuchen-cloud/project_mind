import { Editor, Extension, Node as TiptapNode } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { editorExtensions } from './upstream/apps/docs/src/renderer/editor/extensions';
import { LinkMark } from './upstream/apps/docs/src/renderer/editor/marks';
import { applyEdits, assertContentEdit } from './model';
import { normalizeDocument } from './schema';
import type { EditorController, EditorOptions } from './editor-types';
import type { PmJSON } from './types';

let nextStyleScope = 0;

// File relationships are source data, never navigation in the privileged host.
// Keep only presentation attributes; do not rewrite the model or source ZIP.
function inertAnchors(root: globalThis.Node) {
  if (root.nodeType !== 1) return;
  const element = root as Element;
  const anchors = [...(element.matches('a') ? [element] : []), ...element.querySelectorAll('a')];
  for (const anchor of anchors) {
    const title = anchor.getAttribute('title') ?? anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '';
    for (const name of anchor.getAttributeNames())
      if (!['class', 'style', 'data-style', 'title', 'role'].includes(name)) anchor.removeAttribute(name);
    if (anchor.getAttribute('title') !== title) anchor.setAttribute('title', title);
    if (anchor.getAttribute('role') !== 'link') anchor.setAttribute('role', 'link');
  }
}

const inertLinkMark = LinkMark.extend({
  renderHTML({ mark }) {
    return ['a', { role: 'link', class: mark.attrs.plain ? 'doc-link doc-link-plain' : 'doc-link',
      title: mark.attrs.tooltip ? String(mark.attrs.tooltip) : String(mark.attrs.href ?? '') }, 0];
  },
});
const hostExtensions = editorExtensions.map(extension => {
  if (extension === LinkMark) return inertLinkMark;
  if (!(extension instanceof TiptapNode) || !extension.config.addNodeView) return extension;
  // Protected runs and nested tables bypass marks.ts. Clean their detached DOM
  // before insertion and every synchronous NodeView update before it returns.
  return extension.extend({
    addNodeView() {
      const create = this.parent?.();
      if (!create) return null;
      return props => {
        const nodeView = create(props);
        inertAnchors(nodeView.dom);
        const update = nodeView.update;
        if (update) nodeView.update = (...args) => {
          const accepted = update.apply(nodeView, args);
          inertAnchors(nodeView.dom);
          return accepted;
        };
        return nodeView;
      };
    },
  });
});

export function mountEditor(element: HTMLElement, initial: EditorOptions): EditorController {
  let options = initial;
  let baseline = normalizeDocument(initial.model.document);
  let suppress = false;
  const styleScope = `docx-${++nextStyleScope}`;
  element.dataset.officeDocxScope = styleScope;
  const style = element.ownerDocument.createElement('style');
  function updateStyle() { style.textContent = `@scope ([data-office-docx-scope="${styleScope}"]) {\n${options.model.documentCss}\n}`; }
  updateStyle();
  element.append(style);
  const content = normalizeDocument(applyEdits(baseline, initial.edits));
  assertContentEdit(baseline, content);
  const guard = Extension.create({
    name: 'projectMindContentScope', priority: 10000,
    addProseMirrorPlugins: () => [new Plugin({
      view(view) {
        inertAnchors(view.dom);
        // Sub-editors can mutate their own DOM outside the outer transaction.
        // This observer is confined to this editor and runs before the next
        // browser input task; synchronous NodeView paths are wrapped above.
        const observer = new MutationObserver(() => inertAnchors(view.dom));
        observer.observe(view.dom, { childList: true, attributes: true, subtree: true });
        return { update: current => inertAnchors(current.dom), destroy: () => observer.disconnect() };
      },
      filterTransaction(transaction) {
        if (!transaction.docChanged || suppress) return true;
        if (options.readOnly || options.model.readOnly) return false;
        try { assertContentEdit(baseline, transaction.doc.toJSON() as PmJSON); return true; }
        catch { options.onError?.('此操作无法保留原件数据，请撤销后重试。'); return false; }
      },
    })],
  });
  function createEditor(content: PmJSON): Editor { return new Editor({
    element, extensions: [...hostExtensions, guard], content,
    editable: !options.readOnly && !options.model.readOnly,
    editorProps: { attributes: { role: 'textbox', 'aria-label': 'Word 文档内容', 'aria-multiline': 'true', spellcheck: 'false', class: 'office-docx-content doc-page' } },
    onUpdate: ({ editor: current }) => {
      if (suppress || options.readOnly || options.model.readOnly) return;
      const document = current.getJSON() as PmJSON;
      options.onChange(JSON.stringify(document) === JSON.stringify(baseline) ? [] : [{ type: 'document', document }]);
    },
  }); }
  let editor = createEditor(content);
  return {
    update(next) {
      const rebase = options.model !== next.model;
      options = next;
      updateStyle();
      editor.setEditable(!next.readOnly && !next.model.readOnly, false);
      if (rebase) baseline = normalizeDocument(next.model.document);
      const document = normalizeDocument(applyEdits(baseline, rebase ? [] : next.edits));
      assertContentEdit(baseline, document);
      if (rebase) {
        // A committed model starts a fresh undo history bound to its own source.
        editor.destroy();
        editor = createEditor(document);
      } else if (JSON.stringify(editor.getJSON()) !== JSON.stringify(document)) {
        suppress = true;
        try { editor.commands.setContent(document, { emitUpdate: false }); }
        finally { suppress = false; }
      }
      if (rebase && next.edits.length) next.onChange([]);
    },
    destroy() { editor.destroy(); style.remove(); delete element.dataset.officeDocxScope; },
    undo() { if (!options.readOnly && !options.model.readOnly) editor.commands.undo(); },
    redo() { if (!options.readOnly && !options.model.readOnly) editor.commands.redo(); },
  };
}

export {mountFullEditor} from './full-editor';
