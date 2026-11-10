import type {AgentObjectRef, AgentWorkspaceBinding} from '../lib/agent-types';
import type {OfficeEdit, OfficeModel} from '../lib/office-types';
import type {RecalculateRequest, RecalculateResult, OfficeViewRead} from '../../packages/office-xlsx/types';
import {callAgentCommand} from './agentApi';

export interface FileWorkingStatus {
  object: AgentObjectRef;
  revision: number;
  contentHash: string;
  archivedVersionNumber: number;
  pendingArchive: boolean;
  lastActivityAtMs: number | null;
  archiveDueAtMs: number | null;
}
export interface FileWorkingOpen extends FileWorkingStatus {
  sessionId: string;
  name: string;
  base64: string;
  format: string | null;
  model: OfficeModel | null;
}
export interface FileWorkingSaved extends FileWorkingStatus { noChange: boolean }
export interface FileWorkingSaveInput {
  object: AgentObjectRef;
  sessionId: string;
  expectedRevision: number;
  expectedContentHash: string;
}
function call<T>(command: string, binding: AgentWorkspaceBinding, data: unknown, requestId: string = crypto.randomUUID()) {
  return callAgentCommand<T>(command, requestId, {input: {binding, requestId, data}});
}
export const fileWorkingApi = {
  open: (binding: AgentWorkspaceBinding, object: AgentObjectRef) => call<FileWorkingOpen>('file_working_open', binding, {object}),
  readView: (binding: AgentWorkspaceBinding, data: {object: AgentObjectRef; sessionId: string; read: OfficeViewRead}) => call<unknown>('file_working_read_view', binding, data),
  saveOffice: (binding: AgentWorkspaceBinding, data: FileWorkingSaveInput & {edits: OfficeEdit[]}, requestId: string) => call<FileWorkingSaved>('file_working_save_office', binding, data, requestId),
  saveText: (binding: AgentWorkspaceBinding, data: FileWorkingSaveInput & {text: string}, requestId: string) => call<FileWorkingSaved>('file_working_save_text', binding, data, requestId),
  activity: (binding: AgentWorkspaceBinding, data: {object: AgentObjectRef; sessionId: string}) => call<FileWorkingStatus>('file_working_activity', binding, data),
  close: (binding: AgentWorkspaceBinding, data: {object: AgentObjectRef; sessionId: string}) => call<void>('file_working_close', binding, data),
  tick: (binding: AgentWorkspaceBinding, object: AgentObjectRef) => call<FileWorkingStatus>('file_working_tick', binding, {object}),
  archive: (binding: AgentWorkspaceBinding, object: AgentObjectRef) => call<FileWorkingStatus>('file_working_archive', binding, {object}),
  recalculate: (binding: AgentWorkspaceBinding, data: {object: AgentObjectRef; sessionId: string; recalculation: RecalculateRequest}) => call<RecalculateResult>('file_working_recalculate', binding, data),
};
