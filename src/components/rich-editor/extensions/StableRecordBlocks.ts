import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createRecordBlockId, RECORD_BLOCK_TYPES } from "../../../lib/record-document";

export const STABLE_RECORD_BLOCKS_KEY = new PluginKey("stableRecordBlocks");
const blockTypes = new Set<string>(RECORD_BLOCK_TYPES);
const validId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
const clipboardType = "application/x-project-mind-record-cut";
const consumedCuts = new Set<string>();

// Opt-in until every Record persistence path uses the canonical head/CAS service.
// QuickNote and raw Transcript must not silently acquire Record semantics.
export const StableRecordBlocks = Extension.create({
  name: "stableRecordBlocks",
  addOptions() { return { recordKey: null as string | null }; },
  addGlobalAttributes() {
    return [{ types: [...RECORD_BLOCK_TYPES], attributes: { blockId: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute("data-block-id"),
      renderHTML: (attrs: Record<string, unknown>) => validId(attrs.blockId) ? { "data-block-id": attrs.blockId } : {},
    } } }];
  },
  onCreate() {
    this.editor.view.dispatch(this.editor.state.tr.setMeta(STABLE_RECORD_BLOCKS_KEY, true).setMeta("addToHistory", false));
  },
  addProseMirrorPlugins() {
    const recordKey = this.options.recordKey ?? `editor:${crypto.randomUUID()}`;
    let pendingCut: { token: string; recordKey: string } | null = null;
    const copy = (view: typeof this.editor.view, event: ClipboardEvent) => {
      pendingCut = null;
      if (view.state.selection.empty || !event.clipboardData) return false;
      const { dom, text } = view.serializeForClipboard(view.state.selection.content());
      event.preventDefault();
      event.clipboardData.clearData();
      event.clipboardData.setData("text/html", dom.innerHTML);
      event.clipboardData.setData("text/plain", text);
      if (event.type === "cut") {
        event.clipboardData.setData(clipboardType, JSON.stringify({ version: 1, recordKey, token: crypto.randomUUID() }));
        view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
      }
      return true;
    };
    return [new Plugin({
      key: STABLE_RECORD_BLOCKS_KEY,
      props: {
        handleDOMEvents: {
          copy: (view, event) => copy(view, event),
          cut: (view, event) => copy(view, event),
          paste: (_view, event) => {
            pendingCut = null;
            const raw = event.clipboardData?.getData(clipboardType);
            if (raw && raw.length <= 512) {
              try {
                const value = JSON.parse(raw);
                if (value?.version === 1 && typeof value.recordKey === "string" && typeof value.token === "string"
                  && /^[0-9a-f-]{36}$/.test(value.token)) pendingCut = { token: value.token, recordKey: value.recordKey };
              } catch { /* Foreign clipboard metadata has no Record move semantics. */ }
            }
            return false;
          },
          drop: () => { pendingCut = null; return false; },
        },
        transformPasted: (slice, view) => {
          if (view.dragging || (pendingCut && pendingCut.recordKey === recordKey && !consumedCuts.has(pendingCut.token))) return slice;
          const rewrite = (node: ProseMirrorNode): ProseMirrorNode => {
            if (node.isText) return node;
            const children: ProseMirrorNode[] = [];
            node.content.forEach((child) => children.push(rewrite(child)));
            const attrs = blockTypes.has(node.type.name) ? { ...node.attrs, blockId: createRecordBlockId() } : node.attrs;
            return node.type.create(attrs, Fragment.fromArray(children), node.marks);
          };
          const children: ProseMirrorNode[] = [];
          slice.content.forEach((node) => children.push(rewrite(node)));
          return new Slice(Fragment.fromArray(children), slice.openStart, slice.openEnd);
        },
      },
      appendTransaction(transactions, oldState, state) {
        if (!transactions.some((tr) => tr.docChanged || tr.getMeta(STABLE_RECORD_BLOCKS_KEY))) return null;
        if (pendingCut && transactions.some((tr) => tr.docChanged && (tr.getMeta("paste") || tr.getMeta("uiEvent") === "paste"))) {
          consumedCuts.add(pendingCut.token);
          pendingCut = null;
          if (consumedCuts.size > 512) consumedCuts.delete(consumedCuts.values().next().value!);
        }
        const mapping = new Mapping();
        transactions.forEach((tr) => mapping.appendMapping(tr.mapping));
        const owners = new Map<string, number>();
        oldState.doc.descendants((node, pos) => {
          if (blockTypes.has(node.type.name) && validId(node.attrs.blockId)) {
            const mapped = mapping.mapResult(pos, 1);
            if (!mapped.deleted) owners.set(node.attrs.blockId, mapped.pos);
          }
        });
        const candidates = new Map<string, number[]>();
        state.doc.descendants((node, pos) => {
          if (blockTypes.has(node.type.name) && validId(node.attrs.blockId)) {
            const positions = candidates.get(node.attrs.blockId) ?? [];
            positions.push(pos);
            candidates.set(node.attrs.blockId, positions);
          }
        });
        const winners = new Map([...candidates].map(([id, positions]) => [id,
          positions.includes(owners.get(id) ?? -1) ? owners.get(id)! : positions[0]]));
        const used = new Set(candidates.keys());
        const tr = state.tr;
        state.doc.descendants((node, pos) => {
          if (!blockTypes.has(node.type.name)) return;
          if (validId(node.attrs.blockId) && winners.get(node.attrs.blockId) === pos) return;
          let id: string;
          do { id = createRecordBlockId(); } while (used.has(id));
          used.add(id);
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId: id });
        });
        return tr.docChanged ? tr : null;
      },
    })];
  },
});
