import { fileURLToPath } from 'node:url';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_EDITS = 256;
const formats = new Set(['docx', 'xlsx', 'pptx']);
const failure = (requestId, code, message) => ({ requestId, ok: false, error: { code, message } });

const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
export function validViewRead(read) {
  if (!read || typeof read !== 'object') return false;
  const sheet = () => typeof read.sheetId === 'string' && read.sheetId.length > 0 && read.sheetId.length <= 512;
  if (read.kind === 'range') {
    const r = read.range;
    return only(read, ['kind','sheetId','range']) && sheet() && only(r,['startRow','endRow','startColumn','endColumn'])
      && [r.startRow,r.endRow,r.startColumn,r.endColumn].every(Number.isSafeInteger)
      && r.startRow >= 0 && r.endRow >= r.startRow && r.endRow <= 1048575
      && r.startColumn >= 0 && r.endColumn >= r.startColumn && r.endColumn <= 16383
      && (r.endRow-r.startRow+1)*(r.endColumn-r.startColumn+1) <= 100000;
  }
  if (read.kind === 'formulas' || read.kind === 'outline') return only(read,['kind','sheetId']) && sheet();
  if (read.kind === 'media') return only(read,['kind','visualId']) && typeof read.visualId === 'string' && read.visualId.length > 0 && read.visualId.length <= 1024;
  if (read.kind === 'pivot') return only(read,['kind','path']) && typeof read.path === 'string' && read.path.length > 0 && read.path.length <= 1024;
  return false;
}

/** Native owns this private process and fixed baseline, never a renderer supplied path. */
export function createOfficeViewSession() {
  let workbook, closed = false;
  return {
    async handle(request) {
      const id = typeof request?.requestId === 'string' ? request.requestId : '';
      const data = request?.data;
      const opening = request?.method === 'office.view.open';
      if (closed || !id || id.length > 128 || !only(request,['requestId','method','data'])
          || !['office.view.open','office.view.read'].includes(request.method)
          || !only(data, opening ? ['format','base64'] : ['format','base64','read']) || data.format !== 'xlsx'
          || (workbook && data.base64 !== undefined) || (opening && workbook)
          || (!opening && !validViewRead(data.read))) return failure(id,'INVALID_ARGUMENT','Invalid private Office view request');
      try {
        if (!workbook) {
          if (typeof data.base64 !== 'string' || data.base64.length > Math.ceil(MAX_BYTES/3)*4) return failure(id,'BUDGET_EXCEEDED','View source is missing or exceeds 100 MiB');
          const bytes = Buffer.from(data.base64,'base64');
          if (!bytes.length || bytes.length > MAX_BYTES || bytes.toString('base64') !== data.base64) return failure(id,'INVALID_ARGUMENT','View requires canonical source bytes');
          const engine = await import('./xlsx-engine.mjs');
          const context = {binaryPath:fileURLToPath(new URL(process.platform === 'win32' ? './xlsx-sidecar.exe' : './xlsx-sidecar',import.meta.url)),tempRoot:process.cwd()};
          const initialized = await engine.createViewSession(bytes,context);
          if (closed) {await initialized.close();return failure(id,'INVALID_ARGUMENT','Office view is closed');}
          workbook = initialized;
        }
        return {requestId:id,ok:true,data:opening ? {model:workbook.model} : {result:await workbook.read(data.read)}};
      } catch (error) {
        return failure(id,['INVALID_ARGUMENT','BUDGET_EXCEEDED','SOURCE_NOT_READY'].includes(error?.code) ? error.code : 'SOURCE_NOT_READY',String(error?.message ?? 'Office view failed').slice(0,2048));
      }
    },
    async close() {closed = true;await workbook?.close();workbook = undefined;},
  };
}

/** Data-only Office boundary shared by the GUI and DSH native service. */
export function createOfficeRecalculationSession() {
  const state = { workbook: undefined, closed: false };
  return {
    handle: request => handleOfficeRequest(request, state),
    async close() { state.closed = true; await state.workbook?.close(); state.workbook = undefined; },
  };
}
export async function handleOfficeRequest(request, session) {
  const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
  if (!requestId || requestId.length > 128 || !request || typeof request !== 'object'
      || Object.keys(request).some(key => !['requestId', 'method', 'data'].includes(key))) {
    return failure(requestId, 'INVALID_ARGUMENT', 'Invalid Office request identity');
  }
  const { method, data } = request;
  if (session && (session.closed || method !== 'office.recalculate')) return failure(requestId, 'INVALID_ARGUMENT', 'Private baseline only accepts active recalculation');
  if (session?.workbook && data?.base64 !== undefined) return failure(requestId, 'INVALID_ARGUMENT', 'Private baseline bytes cannot be replaced');
  const retained = !!session?.workbook;
  const creating = method === 'office.create';
  const recalculate = method === 'office.recalculate';
  const allowed = creating ? ['format', 'content'] : recalculate ? ['format', 'base64', 'recalculation'] : ['format', 'base64', 'edits'];
  if (!['office.inspect', 'office.inspectView', 'office.edit', 'office.recalculate', 'office.create'].includes(method) || !data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).some(key => !allowed.includes(key)) || !formats.has(data.format)
      || (recalculate && data.format !== 'xlsx')
      || (creating ? !(typeof data.content === 'string' && data.format === 'docx' && data.content.trim() || data.content && typeof data.content === 'object' && !Array.isArray(data.content)) : !retained && typeof data.base64 !== 'string')) {
    return failure(requestId, 'INVALID_ARGUMENT', 'Expected a supported Office format and fixed source bytes');
  }
  if (creating && Buffer.byteLength(JSON.stringify(data.content), 'utf8') > 2 * 1024 * 1024) {
    return failure(requestId, 'BUDGET_EXCEEDED', 'Office creation content exceeds 2 MiB');
  }
  if (!creating && !retained && data.base64.length > Math.ceil(MAX_BYTES / 3) * 4) {
    return failure(requestId, 'BUDGET_EXCEEDED', 'Office source exceeds 100 MiB');
  }
  // Buffer decoding is permissive; require canonical base64 at the IPC boundary.
  const bytes = creating || retained ? undefined : Buffer.from(data.base64, 'base64');
  if (!creating && !retained && (bytes.toString('base64') !== data.base64 || !bytes.length)) {
    return failure(requestId, 'INVALID_ARGUMENT', 'Office source bytes are incomplete');
  }
  if (!creating && !retained && bytes.length > MAX_BYTES) return failure(requestId, 'BUDGET_EXCEEDED', 'Office source exceeds 100 MiB');
  if (method === 'office.edit' && (!Array.isArray(data.edits) || data.edits.length > MAX_EDITS)) {
    return failure(requestId, 'INVALID_ARGUMENT', 'Expected at most 256 Office edits');
  }
  if (['office.inspect','office.inspectView'].includes(method) && data.edits !== undefined) {
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
    if (method === 'office.inspectView') return { requestId, ok: true, data: { model: await engine.inspectView(bytes, context) } };
    // engine.recalculate reuses workbookRecalcRequestSchema for strict nested
    // fields, coordinates and input lengths before opening the source bytes.
    if (recalculate) {
      if (session) {
        session.workbook ??= await engine.createRecalculationSession(bytes, context);
        return { requestId, ok: true, data: await session.workbook.recalculate(data.recalculation) };
      }
      return { requestId, ok: true, data: await engine.recalculate(bytes, data.recalculation, context) };
    }
    const candidate = creating ? await engine.create(data.content, context) : await engine.edit(bytes, data.edits, context);
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
