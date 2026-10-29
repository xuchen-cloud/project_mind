import type { JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { canonicalDocumentJson, recordBlockIndex, RecordDocumentError, validateRecordDocument } from "./record-document";
import type { RecordPatchPreview } from "./record-patch";
import { parseRecordHtml } from "./record-document-html";
import { renderMarkdownToHtml } from "./richTextContent";
import { serializeRecordDocument } from "./record-document-format";
import { serializeRichTextDocumentMarkdown } from "../components/rich-editor/markdown";
import { diffArrays, diffChars, diffLines } from "diff";

export type RecordTextEdit =
  | { kind: "replace"; oldText: string; newText: string }
  | { kind: "append"; markdown: string }
  | { kind: "markdown"; beforeMarkdown: string; afterMarkdown: string };

const fail = (message: string): never => { throw new RecordDocumentError(message); };
const normalizeNewlines = (value: string) => value.replace(/\r\n/g, "\n");
const parseMarkdown = (value: string, schema: Schema) => {
  const document = parseRecordHtml(renderMarkdownToHtml(normalizeNewlines(value)), schema);
  // Markdown's fenced-code renderer contributes the delimiter's final newline.
  // Remove exactly that newline, retaining any newline in the user's code.
  const visit = (node: JSONContent) => {
    const last = node.content?.[node.content.length - 1];
    if (node.type === "codeBlock" && last?.text?.endsWith("\n")) {
      last.text = last.text!.slice(0, -1);
      if (!last.text) node.content!.pop();
    }
    if (node.type === "bulletList" && node.content?.length && node.content.every((item) => item.type === "listItem"
      && item.content?.[0]?.type === "paragraph" && /^\[[ xX]\] /.test(item.content[0].content?.[0]?.text ?? ""))) {
      node.type = "taskList";
      for (const item of node.content) {
        const first = item.content![0].content![0];
        item.type = "taskItem";
        item.attrs = { ...item.attrs, checked: first.text![1].toLowerCase() === "x" };
        first.text = first.text!.slice(4);
        if (!first.text) item.content![0].content!.shift();
      }
    }
    node.content?.forEach(visit);
  };
  visit(document);
  return document;
};

const ambiguous = (): never => fail("Cannot map this Markdown change without losing structure or identity; narrow the Markdown diff or use replace with a unique oldText for a text-only change");
const workLimit = (): never => fail("Markdown diff exceeds the conversion work limit; use smaller edits or a unique literal replace");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function markdownEdit(document: JSONContent, before: string, after: string, schema: Schema): boolean {
  if (before !== normalizeNewlines(serializeRecordDocument(document, schema).markdown)) fail("Markdown baseline differs from the current document; read the current Markdown and retry");
  if (before === after) return false;
  // Myers diff has bounded work and linear frontiers, rather than an n*m matrix.
  // One shared deadline bounds many small nested diffs as well as a large diff.
  const deadline = Date.now() + 1500;
  const options = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) workLimit();
    return { timeout: Math.min(remaining, 200), maxEditLength: 10000 };
  };
  const keys = new WeakMap<JSONContent, string>();
  const key = (node: JSONContent): string => {
    let value = keys.get(node);
    if (value === undefined) {
      const strip = (current: JSONContent): JSONContent => ({ ...current,
        ...(current.attrs ? { attrs: Object.fromEntries(Object.entries(current.attrs).filter(([name]) => name !== "blockId")) } : {}),
        ...(current.content ? { content: current.content.map(strip) } : {}) });
      value = canonicalDocumentJson(strip(node));
      keys.set(node, value);
    }
    return value;
  };
  const mergeAttrs = (original: JSONContent["attrs"], base: JSONContent["attrs"], next: JSONContent["attrs"]) => {
    const result = { ...original };
    for (const name of new Set([...Object.keys(base ?? {}), ...Object.keys(next ?? {})])) {
      if (name === "blockId" || same(base?.[name], next?.[name])) continue;
      if (next && name in next) result[name] = next[name]; else delete result[name];
    }
    return result;
  };
  type Mark = NonNullable<JSONContent["marks"]>[number];
  const mergeMarks = (original: Mark[] = [], base: Mark[] = [], next: Mark[] = []) => {
    const result: Mark[] = [];
    for (const mark of original) {
      const oldMark = base.find((item) => item.type === mark.type);
      const newMark = next.find((item) => item.type === mark.type);
      if (!oldMark) {
        // Tables omit marks from their Markdown projection. An explicitly
        // supplied mark must still update its visible attrs, while parser
        // defaults must not overwrite invisible target/rel/style metadata.
        const defaults = Object.fromEntries(Object.entries(schema.marks[mark.type].spec.attrs ?? {}).map(([name, attr]) => [name, attr.default]));
        result.push(newMark ? { ...mark, ...(mark.attrs || newMark.attrs ? { attrs: mergeAttrs(mark.attrs, defaults, newMark.attrs) } : {}) } : mark);
      }
      else if (newMark) result.push({ ...mark, ...(mark.attrs || newMark.attrs ? { attrs: mergeAttrs(mark.attrs, oldMark.attrs, newMark.attrs) } : {}) });
    }
    for (const mark of next) if (!original.some((item) => item.type === mark.type)) result.push(mark);
    return result;
  };
  interface Run { from: number; to: number; node: JSONContent }
  const inline = (node: JSONContent) => {
    let text = "";
    const runs: Run[] = [];
    for (const child of node.content ?? []) {
      const from = text.length;
      text += child.type === "text" ? child.text : "\ufffc";
      runs.push({ from, to: text.length, node: child });
    }
    return { text, runs };
  };
  const runAt = (runs: Run[], offset: number): Run | undefined => {
    // Binary lookup avoids rescanning all marks for every diff segment.
    let low = 0, high = runs.length;
    while (low < high) { const mid = (low + high) >>> 1; if (runs[mid].to <= offset) low = mid + 1; else high = mid; }
    return runs[low];
  };
  const mergeInline = (original: JSONContent, base: JSONContent, next: JSONContent) => {
    const o = inline(original), b = inline(base), a = inline(next);
    if (o.text !== b.text) ambiguous();
    const atomCounts = (runs: Run[]) => {
      const counts = new Map<string, number>();
      for (const { node } of runs) if (node.type !== "text") counts.set(key(node), (counts.get(key(node)) ?? 0) + 1);
      return counts;
    };
    const oldAtoms = atomCounts(b.runs), nextAtoms = atomCounts(a.runs);
    for (const [value, count] of oldAtoms) {
      const nextCount = nextAtoms.get(value) ?? 0;
      if (count !== nextCount && nextCount > 0 && Math.max(count, nextCount) > 1) ambiguous();
    }
    const changes = diffChars(b.text, a.text, options());
    if (!changes) return workLimit();
    const content: JSONContent[] = [];
    let bp = 0, ap = 0, removedFrom: number | undefined;
    for (const change of changes) {
      const length = change.value.length;
      if (change.removed) { removedFrom = bp; bp += length; continue; }
      let remaining = length;
      while (remaining) {
        const ar = runAt(a.runs, ap)!;
        const sourceAt = change.added ? (removedFrom ?? bp) : bp;
        const or = runAt(o.runs, sourceAt) ?? o.runs[o.runs.length - 1];
        const br = runAt(b.runs, sourceAt) ?? b.runs[b.runs.length - 1];
        const size = change.added ? Math.min(remaining, ar.to - ap)
          : Math.min(remaining, ar.to - ap, or!.to - bp, br!.to - bp);
        if (size <= 0) ambiguous();
        const marks = mergeMarks(or?.node.marks, br?.node.marks, ar.node.marks);
        if (ar.node.type === "text") {
          if (!change.added && (or?.node.type !== "text" || br?.node.type !== "text")) ambiguous();
          content.push({ type: "text", text: a.text.slice(ap, ap + size), ...(marks.length ? { marks } : {}) });
        } else if (change.added) content.push(ar.node);
        else {
          if (!or || !br || or.node.type !== br.node.type || key(br.node) !== key(ar.node)) ambiguous();
          content.push({ ...or.node, ...(marks.length ? { marks } : {}) });
        }
        ap += size;
        if (!change.added) bp += size;
        remaining -= size;
      }
      removedFrom = undefined;
    }
    return content;
  };

  const mergeNode = (original: JSONContent, base: JSONContent, next: JSONContent): JSONContent => {
    if (key(base) === key(next)) return original;
    const cells = new Set(["tableCell", "tableHeader"]);
    if (original.type !== base.type && !(cells.has(original.type!) && cells.has(base.type!))) ambiguous();
    const type = base.type === next.type ? original.type! : next.type!;
    const listKinds = new Set(["bulletList", "orderedList", "taskList"]);
    const itemKinds = new Set(["listItem", "taskItem"]);
    if (base.type !== next.type && !(schema.nodes[base.type!].inlineContent && schema.nodes[next.type!].inlineContent)
      && !(listKinds.has(base.type!) && listKinds.has(next.type!)) && !(itemKinds.has(base.type!) && itemKinds.has(next.type!))) ambiguous();
    const attrs = mergeAttrs(original.attrs, base.attrs, next.attrs);
    for (const name of Object.keys(attrs)) {
      if (name in (schema.nodes[type].spec.attrs ?? {})) continue;
      if (!same(original.attrs?.[name], base.attrs?.[name])) ambiguous();
      delete attrs[name];
    }
    // Inline text, marks and atoms are reconciled separately. mergeSequence
    // receives block children only, all carrying validated stable block IDs.
    const content = schema.nodes[type].inlineContent ? mergeInline(original, base, next)
      : mergeSequence(original.content ?? [], base.content ?? [], next.content ?? []);
    return { type, attrs, ...(content.length ? { content } : {}) };
  };
  const mergeSequence = (original: JSONContent[], base: JSONContent[], next: JSONContent[]): JSONContent[] => {
    if (!base.length && !original.length) return next;
    if (!next.length) return [];
    if (original.length !== base.length) {
      const invisible = (node: JSONContent) => node.type === "paragraph" && !node.content?.length;
      const visible = original.filter((node) => !invisible(node));
      if (visible.length !== base.length) ambiguous();
      const result = mergeSequence(visible, base, next);
      // Markdown omits empty paragraphs. Keep these exact nodes beside the
      // nearest retained identity instead of treating them as deleted content.
      const retained = new Set(result.map((node) => node.attrs?.blockId));
      const following: (string | undefined)[] = new Array(original.length);
      let nextId: string | undefined;
      for (let i = original.length - 1; i >= 0; i--) {
        following[i] = nextId;
        const id = original[i].attrs?.blockId;
        if (!invisible(original[i]) && retained.has(id)) nextId = id;
      }
      const before = new Map<string, JSONContent[]>(), after = new Map<string, JSONContent[]>();
      const leading: JSONContent[] = [];
      let previousId: string | undefined;
      for (let i = 0; i < original.length;) {
        if (!invisible(original[i])) {
          if (retained.has(original[i].attrs?.blockId)) previousId = original[i].attrs?.blockId;
          i++; continue;
        }
        const start = i;
        while (i < original.length && invisible(original[i])) i++;
        const next = following[start];
        const destination = next ? before : after;
        const id = next ?? previousId;
        if (id) destination.set(id, [...(destination.get(id) ?? []), ...original.slice(start, i)]);
        else leading.push(...original.slice(start, i));
      }
      return [...leading, ...result.flatMap((node) => [...(before.get(node.attrs?.blockId) ?? []), node, ...(after.get(node.attrs?.blockId) ?? [])])];
    }
    const counts = (nodes: JSONContent[]) => {
      const result = new Map<string, number>();
      for (const node of nodes) result.set(key(node), (result.get(key(node)) ?? 0) + 1);
      return result;
    };
    const oldCounts = counts(base), newCounts = counts(next);
    for (const [value, count] of oldCounts) {
      const nextCount = newCounts.get(value) ?? 0;
      if (count !== nextCount && nextCount > 0 && Math.max(count, nextCount) > 1) ambiguous();
    }
    const oldIndexes = new Map(base.map((node, index) => [key(node), index]));
    const retainedSource = (node: JSONContent): JSONContent | undefined => {
      const value = key(node);
      return oldCounts.get(value) === 1 && newCounts.get(value) === 1 ? original[oldIndexes.get(value)!] : undefined;
    };
    const changes = diffArrays(base.map(key), next.map(key), options());
    if (!changes) return workLimit();
    const result: JSONContent[] = [];
    let bp = 0, ap = 0;
    for (let i = 0; i < changes.length;) {
      const part = changes[i];
      if (!part.added && !part.removed) {
        result.push(...original.slice(bp, bp + part.value.length));
        bp += part.value.length; ap += part.value.length; i++; continue;
      }
      let removed = 0, added = 0;
      while (i < changes.length && (changes[i].added || changes[i].removed)) {
        const change = changes[i++];
        if (change.removed) removed += change.value.length; else added += change.value.length;
      }
      if (removed && added) {
        if (removed !== added && removed !== 1 && added !== 1) ambiguous();
        // Splitting/merging cannot transfer Markdown-invisible attributes or
        // atoms to another block by position. Refuse that lossy transformation.
        if (removed !== added) for (let j = 0; j < removed; j++) if (key(original[bp + j]) !== key(base[bp + j])) ambiguous();
        const paired = Math.min(removed, added);
        for (let j = 0; j < paired; j++) result.push(retainedSource(next[ap + j]) ?? mergeNode(original[bp + j], base[bp + j], next[ap + j]));
        result.push(...next.slice(ap + paired, ap + added).map((node) => retainedSource(node) ?? node));
      } else if (added) result.push(...next.slice(ap, ap + added).map((node) => retainedSource(node) ?? node));
      bp += removed; ap += added;
    }
    const originalIds = new Set(original.map((node) => node.attrs?.blockId));
    const retainedIds = new Set(result.map((node) => node.attrs?.blockId));
    if (retainedIds.size !== result.length) ambiguous();
    if (result.some((node) => !originalIds.has(node.attrs?.blockId))) {
      for (let i = 0; i < original.length; i++) {
        if (!retainedIds.has(original[i].attrs?.blockId) && key(original[i]) !== key(base[i])) ambiguous();
      }
    }
    return result;
  };

  const changes = diffLines(before, after, options());
  if (!changes) return workLimit();
  const unchanged: { from: number; to: number; nextFrom: number }[] = [];
  let bp = 0, ap = 0;
  for (const change of changes) {
    if (!change.added && !change.removed) unchanged.push({ from: bp, to: bp + change.value.length, nextFrom: ap });
    if (!change.added) bp += change.value.length;
    if (!change.removed) ap += change.value.length;
  }
  const originals = document.content ?? [];
  const anchors: { index: number; from: number; to: number; nextFrom: number; nextTo: number }[] = [];
  const projections = new Map<string, number[]>();
  const projectedValues: string[] = [];
  let cursor = 0, rangeIndex = 0;
  for (let index = 0; index < originals.length; index++) {
    const value = normalizeNewlines(serializeRichTextDocumentMarkdown(schema.nodeFromJSON({ type: "doc", content: [originals[index]] })));
    projectedValues[index] = value;
    if (!value) continue; // Invisible empty paragraphs remain in their owning region.
    const indexes = projections.get(value) ?? [];
    indexes.push(index);
    projections.set(value, indexes);
    const from = before.indexOf(value, cursor), to = from + value.length;
    if (from < 0 || before.slice(cursor, from).trim()) ambiguous();
    cursor = to;
    while (unchanged[rangeIndex] && unchanged[rangeIndex].to < to) rangeIndex++;
    const range = unchanged[rangeIndex];
    if (range && range.from <= from && range.to >= to) {
      const nextFrom = range.nextFrom + from - range.from;
      anchors.push({ index, from, to, nextFrom, nextTo: nextFrom + value.length });
    }
  }
  const anchored = new Set(anchors.map(({ index }) => index));
  for (const indexes of projections.values()) {
    const retained = indexes.filter((index) => anchored.has(index)).length;
    if (indexes.length > 1 && retained > 0 && retained !== indexes.length) ambiguous();
  }
  const result: JSONContent[] = [];
  let previousIndex = 0, beforeAt = 0, afterAt = 0;
  const region = (endIndex: number, beforeEnd: number, afterEnd: number) => {
    const oldNodes = originals.slice(previousIndex, endIndex);
    const oldText = before.slice(beforeAt, beforeEnd).trim();
    const newText = after.slice(afterAt, afterEnd).trim();
    if (oldText === newText) { result.push(...oldNodes); return; }
    if (!newText) return; // Explicit deletion of the exact baseline region.
    // A uniquely projected, unanchored whole block can move without reparsing
    // its invisible styles or managed references. Exact text is the mapping.
    if (!oldNodes.length) {
      const indexes = projections.get(newText);
      if (indexes?.length === 1 && !anchored.has(indexes[0])) { result.push(originals[indexes[0]]); return; }
    }
    const next = (parseMarkdown(newText, schema).content ?? []).map((node) => {
      const value = serializeRichTextDocumentMarkdown(schema.nodeFromJSON({ type: "doc", content: [node] }));
      const indexes = projections.get(value);
      if (indexes?.length !== 1 || anchored.has(indexes[0]) || (indexes[0] >= previousIndex && indexes[0] < endIndex)) return node;
      return originals[indexes[0]];
    });
    if (!oldNodes.length) { result.push(...next); return; }
    const base = oldText ? parseMarkdown(oldText, schema).content ?? [] : [];
    result.push(...mergeSequence(oldNodes, base, next));
  };
  for (const anchor of anchors) {
    region(anchor.index, anchor.from, anchor.nextFrom);
    result.push(originals[anchor.index]);
    previousIndex = anchor.index + 1; beforeAt = anchor.to; afterAt = anchor.nextTo;
  }
  region(originals.length, before.length, after.length);
  const originalIds = new Set(originals.map((node) => node.attrs?.blockId));
  const retainedIds = new Set(result.map((node) => node.attrs?.blockId));
  if (retainedIds.size !== result.length) ambiguous();
  if (result.some((node) => !originalIds.has(node.attrs?.blockId))) {
    for (let i = 0; i < originals.length; i++) {
      if (retainedIds.has(originals[i].attrs?.blockId)) continue;
      const projected = parseMarkdown(projectedValues[i] ?? "", schema).content ?? [];
      if (projected.length !== 1 || key(originals[i]) !== key(projected[0])) ambiguous();
    }
  }
  const normalizedEmpty = !result.length;
  if (normalizedEmpty) result.push(...parseMarkdown("", schema).content!);
  document.content = result;
  return normalizedEmpty;
}

// A run stops at every inline atom or hard break. Marks do not break a run.
// The replacement inherits the first replaced character's marks; unchanged
// characters always retain their own marks, including links.
function replaceLiteral(document: JSONContent, oldText: string, newText: string) {
  if (!oldText) fail("oldText must not be empty");
  const matches: { parent: JSONContent; start: number; end: number; offset: number }[] = [];
  const visit = (parent: JSONContent) => {
    const children = parent.content ?? [];
    for (let start = 0; start < children.length;) {
      if (children[start].type !== "text") { visit(children[start++]); continue; }
      let end = start;
      let text = "";
      while (children[end]?.type === "text") text += children[end++].text ?? "";
      for (let at = text.indexOf(oldText); at !== -1; at = text.indexOf(oldText, at + 1)) {
        matches.push({ parent, start, end, offset: at });
        if (matches.length > 1) fail("Ambiguous text match: oldText occurs more than once; provide a longer unique oldText or an exact Markdown baseline edit");
      }
      start = end;
    }
  };
  visit(document);
  if (!matches.length) fail("Text not found in a single text block: use a Markdown baseline edit for changes across blocks or inline references");
  const { parent, start, end, offset } = matches[0];
  const changed: JSONContent[] = [];
  let position = 0;
  let inserted = false;
  for (const child of parent.content!.slice(start, end)) {
    const text = child.text!;
    const from = Math.max(0, offset - position);
    const to = Math.min(text.length, offset + oldText.length - position);
    if (from >= text.length || to <= 0) changed.push(child);
    else {
      if (from > 0) changed.push({ ...child, text: text.slice(0, from) });
      if (!inserted) {
        if (newText) changed.push({ ...child, text: newText });
        inserted = true;
      }
      if (to < text.length) changed.push({ ...child, text: text.slice(to) });
    }
    position += text.length;
  }
  parent.content!.splice(start, end - start, ...changed);
}

export async function applyRecordTextEdit(base: JSONContent, edit: RecordTextEdit, schema: Schema): Promise<RecordPatchPreview> {
  const fields: Record<string, string[]> = { replace: ["kind", "oldText", "newText"], append: ["kind", "markdown"], markdown: ["kind", "beforeMarkdown", "afterMarkdown"] };
  if (!edit || typeof edit !== "object" || Array.isArray(edit) || !Object.prototype.hasOwnProperty.call(fields, edit.kind)
    || Object.keys(edit).some((name) => !fields[edit.kind].includes(name))
    || fields[edit.kind].some((name) => typeof (edit as unknown as Record<string, unknown>)[name] !== "string")) fail("Invalid text edit kind or fields");
  const encoder = new TextEncoder();
  for (const field of fields[edit.kind]) {
    if (field !== "kind" && encoder.encode((edit as unknown as Record<string, string>)[field]).length > 1024 * 1024) {
      fail(`Invalid ${field} size: UTF-8 limit is 1 MiB`);
    }
  }
  const document = validateRecordDocument(base, schema);
  const before = canonicalDocumentJson(document);
  const originalIds = new Set(recordBlockIndex(document).map(({ blockId }) => blockId));
  const normalizations: RecordPatchPreview["normalizations"] = [];
  if (edit.kind === "replace") replaceLiteral(document, edit.oldText, edit.newText);
  else if (edit.kind === "append") {
    if (edit.markdown.trim()) document.content = [...(document.content ?? []), ...parseMarkdown(edit.markdown, schema).content!];
  }
  else if (edit.kind === "markdown") {
    if (markdownEdit(document, normalizeNewlines(edit.beforeMarkdown), normalizeNewlines(edit.afterMarkdown), schema)) normalizations.push({ kind: "empty_document_paragraph", blockId: null });
  }
  else fail("Unsupported text edit");
  const validated = validateRecordDocument(document, schema);
  const afterIds = new Set(recordBlockIndex(validated).map(({ blockId }) => blockId));
  return { document: validated, createdBlockIds: [...afterIds].filter((id) => !originalIds.has(id)),
    deletedBlockIds: [...originalIds].filter((id) => !afterIds.has(id)), normalizations,
    noChange: canonicalDocumentJson(validated) === before };
}
