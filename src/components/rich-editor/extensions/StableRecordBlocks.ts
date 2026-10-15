import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { createRecordBlockId, RECORD_BLOCK_TYPES } from "../../../lib/record-document";
import { RECORD_CUT_CLIPBOARD_TYPE, readRecordCutClipboard, recordCutClipboardHtml } from "../recordCutClipboard";

export const STABLE_RECORD_BLOCKS_KEY = new PluginKey("stableRecordBlocks");
const blockTypes = new Set<string>(RECORD_BLOCK_TYPES);
const validId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{32}$/.test(id);
const clipboardType = RECORD_CUT_CLIPBOARD_TYPE;
const consumedCuts = new Set<string>();
const cutSources = new WeakMap<EditorView, { recordKey: string; transport?: RecordCutTransport }>();
export interface RecordClipboardPayload { html: string; text: string }
export interface RecordCutTransport {
  registerCut: (token: string) => Promise<unknown>;
  claimCut: (token: string) => Promise<boolean>;
}
export interface RecordClipboardOptions {
  clipboardPayload?: (view: EditorView) => RecordClipboardPayload | null;
  onCopied?: (view: EditorView, payload: RecordClipboardPayload) => void;
  cutTransport?: RecordCutTransport;
  pasteCut?: (view: EditorView, payload: RecordClipboardPayload, preserveIds: boolean, restoreTarget: () => boolean) => unknown | Promise<unknown>;
}

export function prepareRecordCutHtml(view: EditorView, html: string): string {
  const source = cutSources.get(view);
  if (!source || !view.editable) return html;
  const token = crypto.randomUUID();
  return recordCutClipboardHtml(html, { version: 1, recordKey: source.recordKey, token });
}

export async function registerRecordCutHtml(view: EditorView, html: string) {
  const source = cutSources.get(view);
  const cut = readRecordCutClipboard("", html);
  if (source && cut && source.recordKey === cut.recordKey) await source.transport?.registerCut(cut.token).catch(() => undefined);
}

// Opt-in until every Record persistence path uses the canonical head/CAS service.
// QuickNote and raw Transcript must not silently acquire Record semantics.
export const StableRecordBlocks = Extension.create({
  name: "stableRecordBlocks",
  addOptions() { return { recordKey: null as string | null,
    clipboardPayload: undefined as RecordClipboardOptions["clipboardPayload"],
    onCopied: undefined as RecordClipboardOptions["onCopied"],
    cutTransport: undefined as RecordClipboardOptions["cutTransport"],
    pasteCut: undefined as RecordClipboardOptions["pasteCut"],
  }; },
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
    let pastingCut = false;
    const registrations = new Map<string, Promise<unknown>>();
    let pasteQueue = Promise.resolve();
    const copy = (view: typeof this.editor.view, event: ClipboardEvent) => {
      pendingCut = null;
      if (view.state.selection.empty || !event.clipboardData) return false;
      const { dom, text } = view.serializeForClipboard(view.state.selection.content());
      const payload = this.options.clipboardPayload?.(view) ?? { html: dom.innerHTML, text };
      event.preventDefault();
      event.clipboardData.clearData();
      event.clipboardData.setData("text/html", payload.html);
      event.clipboardData.setData("text/plain", payload.text);
      if (event.type === "cut" && view.editable) {
        const token = crypto.randomUUID();
        event.clipboardData.setData(clipboardType, JSON.stringify({ version: 1, recordKey, token }));
        event.clipboardData.setData("text/html", recordCutClipboardHtml(payload.html, { version: 1, recordKey, token }));
        const previous = view.state.doc;
        view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
        if (!previous.eq(view.state.doc) && this.options.cutTransport) {
          const registered = this.options.cutTransport.registerCut(token).catch(() => undefined);
          registrations.set(token, registered);
          void registered.finally(() => { registrations.delete(token); });
        }
      } else { this.options.onCopied?.(view, payload); }
      return true;
    };
    return [new Plugin({
      key: STABLE_RECORD_BLOCKS_KEY,
      view: (view) => {
        cutSources.set(view, { recordKey, transport: this.options.cutTransport });
        return { destroy: () => { cutSources.delete(view); } };
      },
      props: {
        handleDOMEvents: {
          copy: (view, event) => copy(view, event),
          cut: (view, event) => copy(view, event),
          paste: (view, event) => {
            pendingCut = null;
            if (!view.editable) return false;
            pendingCut = readRecordCutClipboard(event.clipboardData?.getData(clipboardType) ?? "", event.clipboardData?.getData("text/html") ?? "");
            if (pendingCut && this.options.cutTransport) {
              const cut = pendingCut;
              const selection = view.state.selection;
              const bookmark = selection.getBookmark();
              const mapping = new Mapping();
              const mapSelection = ({ transaction }: { transaction: Transaction }) => mapping.appendMapping(transaction.mapping);
              this.editor.on("transaction", mapSelection);
              const restoreTarget = () => {
                if (view.isDestroyed || !view.editable || mapping.mapResult(selection.from, 1).deletedAcross || mapping.mapResult(selection.to, -1).deletedAcross) return false;
                view.dispatch(view.state.tr.setSelection(bookmark.map(mapping).resolve(view.state.doc)).setMeta("addToHistory", false));
                return true;
              };
              const payload = { html: event.clipboardData?.getData("text/html") ?? "", text: event.clipboardData?.getData("text/plain") ?? "" };
              pendingCut = null;
              event.preventDefault();
              pasteQueue = pasteQueue.then(async () => {
                await registrations.get(cut.token);
                const preserve = await this.options.cutTransport!.claimCut(cut.token).catch(() => false);
                try {
                  if (!restoreTarget()) return;
                  pastingCut = true;
                  pendingCut = preserve && cut.recordKey === recordKey ? cut : null;
                  if (this.options.pasteCut) await this.options.pasteCut(view, payload, Boolean(pendingCut), restoreTarget);
                  else if (payload.html) view.pasteHTML(payload.html, event);
                  else view.pasteText(payload.text, event);
                } finally { pendingCut = null; pastingCut = false; this.editor.off("transaction", mapSelection); }
              }).catch(() => { pendingCut = null; pastingCut = false; this.editor.off("transaction", mapSelection); });
              return true;
            }
            return false;
          },
          drop: () => { pendingCut = null; return false; },
        },
        transformPasted: (slice, view) => {
          if ((view.dragging && !pastingCut) || (pendingCut && pendingCut.recordKey === recordKey && !consumedCuts.has(pendingCut.token))) return slice;
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
