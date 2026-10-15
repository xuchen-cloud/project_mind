import type { Editor } from "@tiptap/core";
import type { Node, ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";

function anchor(position: ResolvedPos) {
  for (let depth = position.depth; depth > 0; depth -= 1) {
    const node = position.node(depth);
    if (typeof node.attrs.blockId === "string") {
      return { id: node.attrs.blockId, offset: position.pos - position.before(depth) };
    }
  }
  return null;
}
function find(document: Node, id: string) {
  let found: { pos: number; node: Node } | null = null;
  document.descendants((node, pos) => {
    if (node.attrs.blockId === id) found = { pos, node };
    return !found;
  });
  return found as { pos: number; node: Node } | null;
}

/** Apply one transaction and retain selection by stable anchors, including moved blocks. */
export function applyRecordIncomingDocument(editor: Editor, incoming: Node) {
  const { doc, selection } = editor.state;
  if (doc.eq(incoming)) return;
  let prefix = 0;
  let from = 0;
  while (prefix < doc.childCount && prefix < incoming.childCount && doc.child(prefix).eq(incoming.child(prefix))) {
    from += doc.child(prefix).nodeSize;
    prefix += 1;
  }
  let suffix = 0;
  let oldEnd = doc.content.size;
  let newEnd = incoming.content.size;
  while (suffix < doc.childCount - prefix && suffix < incoming.childCount - prefix
    && doc.child(doc.childCount - 1 - suffix).eq(incoming.child(incoming.childCount - 1 - suffix))) {
    oldEnd -= doc.child(doc.childCount - 1 - suffix).nodeSize;
    newEnd -= incoming.child(incoming.childCount - 1 - suffix).nodeSize;
    suffix += 1;
  }
  const transaction = editor.state.tr.replaceWith(from, oldEnd, incoming.content.cut(from, newEnd));
  const start = anchor(selection.$anchor);
  const end = anchor(selection.$head);
  const relocate = (value: ReturnType<typeof anchor>, fallback: number) => {
    const block = value && find(transaction.doc, value.id);
    return block ? block.pos + Math.min(value!.offset, block.node.nodeSize - 1)
      : transaction.mapping.map(fallback);
  };
  if (selection instanceof CellSelection) {
    const first = find(transaction.doc, selection.$anchorCell.nodeAfter!.attrs.blockId);
    const last = find(transaction.doc, selection.$headCell.nodeAfter!.attrs.blockId);
    if (first && last) transaction.setSelection(CellSelection.create(transaction.doc, first.pos, last.pos));
  } else if (selection instanceof NodeSelection) {
    const block = find(transaction.doc, selection.node.attrs.blockId);
    if (block && NodeSelection.isSelectable(block.node)) transaction.setSelection(NodeSelection.create(transaction.doc, block.pos));
  } else if (selection instanceof TextSelection) {
    const nextAnchor = Selection.near(transaction.doc.resolve(relocate(start, selection.anchor))).anchor;
    const nextHead = Selection.near(transaction.doc.resolve(relocate(end, selection.head))).head;
    transaction.setSelection(TextSelection.create(transaction.doc, nextAnchor, nextHead));
  }
  editor.view.dispatch(transaction.setMeta("addToHistory", false).setMeta("recordIncoming", true));
}
