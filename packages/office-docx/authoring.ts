import { blankDocument, openDocument, fillFromHtml, applyDocOps, saveDocument, closeDocument, docsCatalog, describeDocument, listStyles, listTableStyles, headerFooterState, listNotes } from './upstream/packages/cli/src/formats/docx';
import { withFingerprint, type JsonSchema } from './upstream/packages/cli/src/op-catalog';
import { listSections } from './upstream/packages/cli/src/formats/docx-sections';
import { DOMParser } from './create-dom';
import { DocxError, type CreateContent, type AuthoringSummary } from './types';
const invalid = (message: string): never => { throw new DocxError('INVALID_ARGUMENT', message); };
const tags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'u', 's', 'a', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'blockquote', 'formula']);
function validateHtml(html: string) {
    if (/<!|<\?/.test(html))
        invalid('HTML declarations and comments are unsupported');
    for (const match of html.matchAll(/<\/?\s*([a-z][a-z0-9:-]*)\b/gi))
        if (!tags.has(match[1].toLowerCase()))
            invalid(`Unsupported Word authoring HTML tag: ${match[1]}`);
    const document = new DOMParser().parseFromString(html, 'text/html');
    const stack = Array.from(document.body.childNodes).map(node => ({ node, depth: 0, cell: false }));
    let count = 0;
    while (stack.length) {
        const { node, depth, cell } = stack.pop()!;
        if (++count > 50000 || depth > 64)
            throw new DocxError('BUDGET_EXCEEDED', 'Word HTML exceeds node or depth budget');
        if (node.nodeType !== 1)
            continue;
        const el = node as unknown as Element, tag = el.tagName.toLowerCase();
        for (const attr of Array.from(el.attributes))
            if (!(tag === 'a' && attr.name === 'href'))
                invalid('Use authoring operations for Word formatting; HTML attributes are unsupported');
        if (cell && !['p', 'br'].includes(tag))
            invalid('Word HTML table cells contain plain text; format native tables with operations');
        for (const child of Array.from(node.childNodes))
            stack.push({ node: child, depth: depth + 1, cell: cell || tag === 'td' || tag === 'th' });
    }
}
/** Validate the actual catalog's JSON data shapes; execution still uses upstream validators. */
function validateSchema(value: unknown, schema: JsonSchema, path: string): void {
    const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
    const matches = (type: string) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
    if (types && !types.some(matches))
        invalid(`${path} has the wrong type`);
    if (schema.enum && !schema.enum.includes(value))
        invalid(`${path} must match an allowed value`);
    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems)
            invalid(`${path} has an invalid item count`);
        if (schema.items)
            value.forEach((item, index) => validateSchema(item, schema.items!, `${path}[${index}]`));
    }
    else if (value && typeof value === 'object' && schema.properties) {
        const data = value as Record<string, unknown>;
        for (const key of Object.keys(data))
            if (!Object.hasOwn(schema.properties, key))
                invalid(`Unknown field ${path}.${key}`);
        for (const key of schema.required ?? [])
            if (!Object.hasOwn(data, key))
                invalid(`Missing field ${path}.${key}`);
        for (const [key, item] of Object.entries(data))
            validateSchema(item, schema.properties[key], `${path}.${key}`);
    }
}
async function validateOperations(ops: unknown): Promise<Record<string, unknown>[]> {
    if (!Array.isArray(ops) || ops.length > 256)
        invalid('Expected at most 256 Word authoring operations');
    if (Buffer.byteLength(JSON.stringify(ops), 'utf8') > 2 * 1024 * 1024)
        throw new DocxError('BUDGET_EXCEEDED', 'Word operations exceed 2 MiB');
    const known = new Map((await docsCatalog()).catalog.ops.map(def => [def.op, def]));
    for (const op of ops) {
        if (!op || typeof op !== 'object' || Array.isArray(op) || typeof op.op !== 'string')
            invalid('Every Word authoring operation needs an op name');
        if (typeof op.html === 'string')
            validateHtml(op.html);
        const def = known.get(op.op);
        if (!def)
            invalid(`Unknown Word operation: ${op.op}`);
        const fields = new Set(['op', ...(def.keys ?? []), ...Object.keys(def.schema?.properties ?? {}), ...(def.target ? ['target'] : [])]);
        for (const key of Object.keys(op))
            if (!fields.has(key))
                invalid(`Unknown field ${key} in Word operation ${op.op}`);
        if (def.schema) {
            const { op: name, ...input } = op;
            validateSchema(input, def.schema, name);
        }
        else if (op.target && typeof op.target === 'object' && !Array.isArray(op.target)) {
            const target = op.target as Record<string, unknown>;
            for (const key of Object.keys(target))
                if (!['nodeType', 'headingLevel', 'containsText', 'matchCase', 'blockIndexes', 'scope', 'range'].includes(key))
                    invalid(`Unknown target field ${key}`);
            if (target.range && typeof target.range === 'object')
                for (const key of Object.keys(target.range))
                    if (!['from', 'to'].includes(key))
                        invalid(`Unknown target range field ${key}`);
        }
    }
    return ops;
}
async function apply(doc: Awaited<ReturnType<typeof openDocument>>, ops: Record<string, unknown>[]) {
    // Upstream requires a context for inline image decoding. The build replaces its
    // image-source module, so this carries no filesystem authority.
    try {
        await applyDocOps(doc, ops, { ctx: { cwd: '/', env: {} } as never });
    }
    catch (error) {
        if (error instanceof Error && error.name === 'CliError')
            invalid(error.message);
        throw error;
    }
}
export async function createStructured(content: Exclude<CreateContent, string>): Promise<Uint8Array> {
    if (!content || typeof content !== 'object' || Array.isArray(content) || Object.keys(content).some(k => !['html', 'ops'].includes(k)))
        invalid('Word creation accepts html and ops only');
    if (content.html !== undefined && typeof content.html !== 'string')
        invalid('Word html must be text');
    const ops = await validateOperations(content.ops ?? []);
    if (!content.html?.trim() && !ops.length)
        invalid('Word creation requires html or authoring operations');
    if (Buffer.byteLength(JSON.stringify(content), 'utf8') > 2 * 1024 * 1024)
        throw new DocxError('BUDGET_EXCEEDED', 'Word creation content exceeds 2 MiB');
    if (content.html)
        validateHtml(content.html);
    const doc = await blankDocument();
    try {
        if (content.html?.trim())
            fillFromHtml(doc, content.html);
        await apply(doc, ops);
        return new Uint8Array(await saveDocument(doc));
    }
    finally {
        closeDocument(doc);
    }
}
export async function editOperations(bytes: Uint8Array, ops: Record<string, unknown>[]): Promise<Uint8Array> {
    await validateOperations(ops);
    const doc = await openDocument(bytes);
    try {
        if (doc.parsed.protection?.enforced || doc.parsed.writeProtection?.hash)
            throw new DocxError('READ_ONLY', 'This document is protected');
        await apply(doc, ops);
        return new Uint8Array(await saveDocument(doc));
    }
    finally {
        closeDocument(doc);
    }
}
export async function summary(bytes: Uint8Array, parsed?: Awaited<ReturnType<typeof import('./upstream/packages/docx-engine/src/index').parseDocx>>): Promise<AuthoringSummary> {
    // authoring-summary-build adapts this pinned entry with a real, unmounted
    // Tiptap Editor. Read helpers use the identical schema/state; edits keep the
    // original mounted editor and DOM. Reuse the validated parse on inspection.
    const read = openDocument as typeof openDocument & ((bytes: Uint8Array, initial: {summary:true;parsed:NonNullable<typeof parsed>})=>ReturnType<typeof openDocument>);
    const doc = parsed ? await read(bytes,{summary:true,parsed}) : await openDocument(bytes);
    try {
        return { blocks: describeDocument(doc, undefined, 10000), styles: listStyles(doc), tableStyles: listTableStyles(doc), sections: listSections(doc), headersFooters: headerFooterState(doc), notes: listNotes(doc) } as unknown as AuthoringSummary;
    }
    finally {
        closeDocument(doc);
    }
}
export async function catalog() {
    const result = await docsCatalog();
    const mediaPolicy = 'Canonical inline PNG/JPEG/GIF data URLs only; file paths and HTTP(S) URLs are rejected.';
    const ops = result.catalog.ops.map(def => {
        const field = def.op === 'set_watermark' ? 'image' : ['insert_image', 'insert_picture'].includes(def.op) ? 'url' : null;
        if (!field || !def.schema?.properties?.[field])
            return def;
        return { ...def, note: `${mediaPolicy} ${def.note ?? ''}`, schema: { ...def.schema, properties: { ...def.schema.properties, [field]: { ...def.schema.properties[field], description: mediaPolicy } } } };
    });
    const { fingerprint: original, ...base } = result.catalog;
    return { ...result, mediaPolicy, catalog: withFingerprint({ ...base, ops }) };
}
