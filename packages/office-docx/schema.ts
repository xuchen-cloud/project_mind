import { getSchema } from '@tiptap/core';
import { editorExtensions } from './upstream/apps/docs/src/renderer/editor/extensions';
import { DocxError, type PmJSON } from './types';
import { assertJson } from './model';

export const schema = getSchema(editorExtensions);
export function normalizeDocument(document: PmJSON): PmJSON {
  assertJson(document);
  function attrs(value: unknown, allowed: string[]) {
    if (value === undefined) return;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
      throw new DocxError('INVALID_JSON', 'Unknown or invalid ProseMirror attribute');
  }
  function node(value: any) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string' ||
        !Object.hasOwn(schema.nodes, value.type) || Object.keys(value).some(k => !['type', 'attrs', 'content', 'text', 'marks'].includes(k)))
      throw new DocxError('INVALID_JSON', 'Unknown or invalid ProseMirror node');
    attrs(value.attrs, Object.keys(schema.nodes[value.type].spec.attrs ?? {}));
    if (value.type === 'text' ? typeof value.text !== 'string' || value.content !== undefined : value.text !== undefined)
      throw new DocxError('INVALID_JSON', 'Invalid ProseMirror text');
    if (value.content !== undefined) {
      if (!Array.isArray(value.content)) throw new DocxError('INVALID_JSON', 'Invalid node content');
      value.content.forEach(node);
    }
    if (value.marks !== undefined) {
      if (!Array.isArray(value.marks)) throw new DocxError('INVALID_JSON', 'Invalid marks');
      for (const mark of value.marks) {
        if (!mark || typeof mark !== 'object' || Array.isArray(mark) || typeof mark.type !== 'string' ||
            !Object.hasOwn(schema.marks, mark.type) || Object.keys(mark).some(k => k !== 'type' && k !== 'attrs'))
          throw new DocxError('INVALID_JSON', 'Unknown or invalid ProseMirror mark');
        attrs(mark.attrs, Object.keys(schema.marks[mark.type].spec.attrs ?? {}));
      }
    }
  }
  if (document.type !== 'doc' || !Array.isArray(document.content)) throw new DocxError('INVALID_JSON', 'Expected a ProseMirror document');
  node(document);
  try {
    const parsed = schema.nodeFromJSON(document);
    parsed.check();
    return parsed.toJSON() as PmJSON;
  } catch (error) { throw new DocxError('INVALID_JSON', error instanceof Error ? error.message : 'Invalid ProseMirror document'); }
}
