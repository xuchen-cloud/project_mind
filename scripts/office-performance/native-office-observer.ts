/** Passive evidence for native-page. No commands, model mutation or renderer data synthesis. */
import type { AgentObjectRef, AgentSourceRef, AgentWorkspaceBinding } from '../../src/lib/agent-types';
import type { Area, Cell, Model as XlsxModel, Range } from '../../packages/office-xlsx/types';
import type { FileWorkingOpen } from '../../src/services/fileWorkingApi';
import type { OfficeModel } from '../../src/lib/office-types';

interface Source {
  object: AgentObjectRef; binding: AgentWorkspaceBinding; protocol: 'version' | 'working';
  versionNumber: number; contentHash: string; sessionId?: string; revision?: number;
}
type ViewRead = {kind: 'media'; visualId: string} | {kind: 'range'; sheetId: string; range: Area};
interface Media { mediaType: string; base64: string }
type ObservedRead = {observation: Observation} & (
  {kind: 'media'; read: Extract<ViewRead, {kind: 'media'}>; result: Media} |
  {kind: 'range'; read: Extract<ViewRead, {kind: 'range'}>; result: Range});
export interface NativeOfficeView {
  cells: Record<string, Cell[]>; media: Record<string, unknown>; source?: Source;
  reads: {requestId: string; command: string; read: ViewRead}[];
}
interface Input {
  binding: AgentWorkspaceBinding; requestId: string;
  data: { object: AgentObjectRef; versionNumber?: number; expectedContentHash?: string; sessionId?: string; read?: ViewRead | null };
}
interface Observation {
  name: string; input: Input; sequence: number; source?: Source; model?: OfficeModel; read?: ViewRead;
}
function objectKey(object: AgentObjectRef): string {
  return JSON.stringify([object.workspaceId, object.scope.kind,
    object.scope.kind === 'project' ? object.scope.projectId : null, object.kind, object.id]);
}
function fileObject(object: AgentObjectRef | undefined): object is AgentObjectRef {
  return !!object && object.kind === 'file' && typeof object.id === 'string' &&
    typeof object.workspaceId === 'string' && (object.scope?.kind === 'workspace' ||
      (object.scope?.kind === 'project' && typeof object.scope.projectId === 'number'));
}
function fixedSource(input: Input): Source | undefined {
  const {object, versionNumber, expectedContentHash} = input.data;
  if (!Number.isInteger(versionNumber) || versionNumber! < 1 || typeof expectedContentHash !== 'string' || !expectedContentHash) return;
  return {object, binding: input.binding, protocol: 'version', versionNumber: versionNumber!, contentHash: expectedContentHash};
}
function sourceMatchesModel(source: Source, model: OfficeModel): boolean {
  return model.format !== 'xlsx' || !model.coverage || model.coverage.sourceHash === source.contentHash.replace(/^sha256:/u, '');
}

function sourceKey(source: Source): string {
  return JSON.stringify([objectKey(source.object), source.binding.generation, source.protocol,
    source.sessionId ?? source.versionNumber, source.contentHash]);
}
function sessionKey(input: Input, sessionId: string): string {
  return JSON.stringify([objectKey(input.data.object), input.binding.generation, sessionId]);
}
function validMedia(value: unknown): value is Media {
  const media = value as Media | null;
  return typeof media?.mediaType === 'string' && media.mediaType.startsWith('image/') &&
    typeof media.base64 === 'string' && media.base64.length > 0;
}
function validRange(read: Extract<ViewRead, {kind: 'range'}>, value: unknown): value is Range {
  const result = value as Range | null, area = result?.area;
  return result?.rangeReady === true && !!area &&
    (['startRow', 'endRow', 'startColumn', 'endColumn'] as const).every(key => area[key] === read.range[key]) &&
    Array.isArray(result.cells) && result.cells.every(cell => cell && Number.isInteger(cell.row) && Number.isInteger(cell.column) &&
      cell.row >= area.startRow && cell.row <= area.endRow && cell.column >= area.startColumn && cell.column <= area.endColumn);
}

export class NativeOfficeObserver {
  private sequence = 0;
  private sessions = new Map<string, Source>();
  private reads = new Map<string, Map<string, ObservedRead>>();
  private viewCache = new WeakMap<XlsxModel, {sequence: number; view: NativeOfficeView}>();
  private readSequence = 0;
  private latest = new Map<string, Observation>();
  private sources = new WeakMap<OfficeModel, Source>();

  started(name: string, payload?: Record<string, unknown>): Observation | undefined {
    if (!['file_office_view', 'file_office_inspect', 'file_office_save', 'file_working_open', 'file_working_read_view'].includes(name)) return;
    const value = payload?.input as Input | undefined;
    if (!fileObject(value?.data?.object) || value?.binding?.workspaceId !== value.data.object.workspaceId ||
      typeof value.binding.generation !== 'string' || typeof value.requestId !== 'string') return;
    // Capture identity before await; completion order must not select the view.
    const input = {...value, binding: {...value.binding}, data: {...value.data,
      object: {...value.data.object, scope: {...value.data.object.scope}}}};
    const read = input.data.read;
    const observation: Observation = {name, input, sequence: ++this.sequence};
    if ((name === 'file_office_view' || name === 'file_working_read_view') && read != null) {
      // Other real read kinds (formula inventory, outline, pivot) are not visual witnesses.
      if (read.kind !== 'media' && read.kind !== 'range') return;
      observation.read = read.kind === 'range' ? {...read, range: {...read.range}} : {...read};
      observation.source = name === 'file_office_view' ? fixedSource(input)
        : this.sessions.get(sessionKey(input, input.data.sessionId ?? ''));
      return observation;
    }
    if (name === 'file_working_read_view') return;
    this.latest.set(objectKey(input.data.object), observation);
    return observation;
  }

  settled(observation: Observation | undefined, result: unknown): void {
    if (!observation) return;
    const response = result as {ok?: boolean; apiVersion?: number; requestId?: string; data?: unknown} | null;
    if (response?.ok !== true || response.apiVersion !== 1 || response.requestId !== observation.input.requestId) return;
    const {name, input} = observation;
    const data = response.data as (Partial<FileWorkingOpen> & {versionNumber?: number; result?: unknown}) | undefined;
    if (observation.read) {
      const source = observation.source, read = observation.read;
      if (!source) return;
      const value = name === 'file_office_view' ? data?.result : response.data;
      let accepted: ObservedRead;
      if (read.kind === 'media' && validMedia(value)) accepted = {observation, kind: 'media', read, result: value};
      else if (read.kind === 'range' && validRange(read, value)) accepted = {observation, kind: 'range', read, result: value};
      else return;
      const key = sourceKey(source), reads = this.reads.get(key) ?? new Map();
      const readKey = JSON.stringify(read), previous = reads.get(readKey);
      if (previous && previous.observation.sequence > observation.sequence) return;
      reads.set(readKey, accepted); this.reads.set(key, reads); this.readSequence++;
      return;
    }
    const model = data?.model;
    if (!data || !model || !['docx', 'xlsx', 'pptx'].includes(model.format)) return;
    let source: Source | undefined;
    if (name === 'file_working_open') {
      if (!fileObject(data.object) || objectKey(data.object) !== objectKey(input.data.object) ||
        typeof data.sessionId !== 'string' || !data.sessionId || typeof data.contentHash !== 'string' || !data.contentHash ||
        typeof data.revision !== 'number' || !Number.isInteger(data.revision) || typeof data.archivedVersionNumber !== 'number') return;
      source = {object: input.data.object, binding: input.binding, protocol: 'working',
        sessionId: data.sessionId, revision: data.revision, versionNumber: data.archivedVersionNumber, contentHash: data.contentHash};
    } else if (name === 'file_office_save') {
      source = fixedSource({...input, data: {...input.data, versionNumber: data.versionNumber, expectedContentHash: data.contentHash}});
    } else source = fixedSource(input);
    if (!source || !sourceMatchesModel(source, model)) return;
    if (data.object && (!fileObject(data.object) || objectKey(data.object) !== objectKey(source.object))) return;
    if (name !== 'file_working_open' && ((data.versionNumber !== undefined && data.versionNumber !== source.versionNumber) ||
      (data.contentHash !== undefined && data.contentHash !== source.contentHash))) return;
    observation.source = source; observation.model = model;
    this.sources.set(model, source);
    if (source.sessionId) this.sessions.set(sessionKey(input, source.sessionId), source);
  }

  /** Known cells only: never widen a Range's coverage or mutate the renderer model. */
  view(model: XlsxModel): NativeOfficeView {
    const cached = this.viewCache.get(model);
    if (cached?.sequence === this.readSequence) return cached.view;
    const source = this.sources.get(model);
    const cells = Object.fromEntries(Object.entries(model.ranges).map(([sheet, range]) => [sheet, range.cells]));
    const media = {...model.rendererData?.media};
    const reads = source ? [...(this.reads.get(sourceKey(source))?.values() ?? [])]
      .sort((a, b) => a.observation.sequence - b.observation.sequence) : [];
    const used: NativeOfficeView['reads'] = [];
    for (const {observation, kind, read, result} of reads) {
      if (kind === 'media') media[read.visualId] = result;
      else {
        if (!model.sheets.some(sheet => sheet.id === read.sheetId)) continue;
        const area = read.range;
        cells[read.sheetId] = [...(cells[read.sheetId] ?? []).filter(cell => cell.row < area.startRow ||
          cell.row > area.endRow || cell.column < area.startColumn || cell.column > area.endColumn), ...result.cells].sort((a, b) => a.row - b.row || a.column - b.column);
      }
      used.push({requestId: observation.input.requestId, command: observation.name, read});
    }
    const view = {cells, media, source, reads: used};
    this.viewCache.set(model, {sequence: this.readSequence, view});
    return view;
  }

  get(object: AgentObjectRef, selected?: AgentSourceRef | null): OfficeModel | undefined {
    const observation = this.latest.get(objectKey(object)), source = observation?.source;
    if (selected && (!source || objectKey(selected.object) !== objectKey(source.object) ||
      selected.fileVersion !== source.versionNumber || selected.revision !== source.contentHash)) return;
    return observation?.model;
  }
}
