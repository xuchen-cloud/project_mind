import { fileURLToPath } from 'node:url';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_EDITS = 256;
const formats = new Set(['docx', 'xlsx', 'pptx']);
const failure = (requestId, code, message) => ({ requestId, ok: false, error: { code, message } });

/** Data-only Office boundary shared by the GUI and DSH native service. */
export async function handleOfficeRequest(request) {
  const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
  if (!requestId || requestId.length > 128 || !request || typeof request !== 'object'
      || Object.keys(request).some(key => !['requestId', 'method', 'data'].includes(key))) {
    return failure(requestId, 'INVALID_ARGUMENT', 'Invalid Office request identity');
  }
  const { method, data } = request;
  const creating = method === 'office.create';
  const recalculate = method === 'office.recalculate';
  const allowed = creating ? ['format', 'content'] : recalculate ? ['format', 'base64', 'recalculation'] : ['format', 'base64', 'edits'];
  if (!['office.inspect', 'office.edit', 'office.recalculate', 'office.create'].includes(method) || !data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !allowed.includes(key)) || !formats.has(data.format)
      || (recalculate && data.format !== 'xlsx')
      || (creating ? data.format !== 'docx' || typeof data.content !== 'string' || !data.content.trim() : typeof data.base64 !== 'string')) {
    return failure(requestId, 'INVALID_ARGUMENT', 'Expected a supported Office format and fixed source bytes');
  }
  if (creating && Buffer.byteLength(data.content, 'utf8') > 2 * 1024 * 1024) {
    return failure(requestId, 'BUDGET_EXCEEDED', 'DOCX creation content exceeds 2 MiB');
  }
  if (!creating && data.base64.length > Math.ceil(MAX_BYTES / 3) * 4) {
    return failure(requestId, 'BUDGET_EXCEEDED', 'Office source exceeds 100 MiB');
  }
  // Buffer decoding is permissive; require canonical base64 at the IPC boundary.
  const bytes = creating ? undefined : Buffer.from(data.base64, 'base64');
  if (!creating && (bytes.toString('base64') !== data.base64 || !bytes.length)) {
    return failure(requestId, 'INVALID_ARGUMENT', 'Office source bytes are incomplete');
  }
  if (!creating && bytes.length > MAX_BYTES) return failure(requestId, 'BUDGET_EXCEEDED', 'Office source exceeds 100 MiB');
  if (method === 'office.edit' && (!Array.isArray(data.edits) || data.edits.length > MAX_EDITS)) {
    return failure(requestId, 'INVALID_ARGUMENT', 'Expected at most 256 Office edits');
  }
  if (method === 'office.inspect' && data.edits !== undefined) {
    return failure(requestId, 'INVALID_ARGUMENT', 'Inspection does not accept edits');
  }
  if (recalculate) {
    const input = data.recalculation;
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => !['edits','reads'].includes(key))
        || !Array.isArray(input.edits) || !Array.isArray(input.reads)) {
      return failure(requestId, 'INVALID_ARGUMENT', 'Expected recalculation edits and reads only');
    }
    if (input.edits.length > 10000 || input.reads.length > 200) {
      return failure(requestId, 'BUDGET_EXCEEDED', 'Recalculation exceeds 10000 edits or 200 reads');
    }
    let cells = 0;
    for (const read of input.reads) {
      const r = read?.range;
      if (r && [r.startRow,r.endRow,r.startColumn,r.endColumn].every(Number.isSafeInteger)
          && r.endRow >= r.startRow && r.endColumn >= r.startColumn) {
        cells += (r.endRow-r.startRow+1)*(r.endColumn-r.startColumn+1);
      }
    }
    if (cells > 100000) return failure(requestId, 'BUDGET_EXCEEDED', 'Recalculation exceeds 100000 read cells');
  }
  try {
    const engine = await import(`./${data.format}-engine.mjs`);
    const context = { binaryPath: fileURLToPath(new URL(process.platform === 'win32' ? './xlsx-sidecar.exe' : './xlsx-sidecar', import.meta.url)), tempRoot: process.cwd() };
    if (method === 'office.inspect') return { requestId, ok: true, data: { model: await engine.inspect(bytes, context) } };
    // engine.recalculate reuses workbookRecalcRequestSchema for strict nested
    // fields, coordinates and input lengths before opening the source bytes.
    if (recalculate) return { requestId, ok: true, data: await engine.recalculate(bytes, data.recalculation, context) };
    const candidate = creating ? await engine.create(data.content) : await engine.edit(bytes, data.edits, context);
    if (!(candidate instanceof Uint8Array) || candidate.byteLength > MAX_BYTES) {
      return failure(requestId, 'BUDGET_EXCEEDED', 'Office candidate exceeds 100 MiB');
    }
    return { requestId, ok: true, data: { base64: Buffer.from(candidate).toString('base64'), model: await engine.inspect(candidate, context) } };
  } catch (error) {
    const known = new Set(['INVALID_ARGUMENT', 'INVALID_PATCH', 'BUDGET_EXCEEDED', 'SOURCE_NOT_READY', 'RUNTIME_UNAVAILABLE']);
    return failure(requestId, known.has(error?.code) ? error.code : error?.name === 'ZodError' ? 'INVALID_ARGUMENT' : method === 'office.edit' ? 'INVALID_PATCH' : 'SOURCE_NOT_READY',
      typeof error?.message === 'string' ? error.message.slice(0, 2048) : 'Office conversion failed');
  }
}
