import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";

import type {
  AcceptedSuggestionResult,
  ActivityCardData,
  ActivityCreateInput,
  ActivityUpdateMetaInput,
  AiAcceptSuggestionInput,
  AiGenerateInput,
  AiSuggestionRecord,
  ConclusionCreateInput,
  ConclusionListInput,
  ConclusionRecord,
  ConclusionUpdateInput,
  DocumentImportInput,
  DocumentRecord,
  DocumentRelocateInput,
  DocumentUpdateMetaInput,
  NoteAppendQuickInput,
  NoteRecord,
  NoteUpsertMinutesInput,
  ProjectCreateInput,
  ProjectDashboard,
  ProjectArchiveInput,
  ProjectIdInput,
  ProjectListItem,
  ProjectOverviewData,
  ProjectRecord,
  ProjectUpdateSummaryInput,
  ProjectsListInput,
  TodoAddProgressInput,
  TodoCreateInput,
  TodoProgressRecord,
  TodoRecord,
  TodoUpdateStatusInput,
  WorkspaceSearchInput,
  WorkspaceSearchResult,
} from "./types";

const command = <T>(name: string, payload?: Record<string, unknown>) =>
  invoke<T>(name, payload);

export const api = {
  projectsList: (input: ProjectsListInput = {}) =>
    command<ProjectListItem[]>("projects_list", { input }),
  projectCreate: (input: ProjectCreateInput) =>
    command<ProjectRecord>("project_create", { input }),
  projectGetDashboard: (input: ProjectIdInput) =>
    command<ProjectDashboard>("project_get_dashboard", { input }),
  projectGetOverview: (input: ProjectIdInput) =>
    command<ProjectOverviewData>("project_get_overview", { input }),
  projectUpdateSummary: (input: ProjectUpdateSummaryInput) =>
    command<ProjectRecord>("project_update_summary", { input }),
  projectSetArchive: (input: ProjectArchiveInput) =>
    command<ProjectRecord>("project_set_archive", { input }),
  activityCreate: (input: ActivityCreateInput) =>
    command<ActivityCardData>("activity_create", { input }),
  activityList: (input: ProjectIdInput) =>
    command<ActivityCardData[]>("activity_list", { input }),
  activityUpdateMeta: (input: ActivityUpdateMetaInput) =>
    command<ActivityCardData>("activity_update_meta", { input }),
  noteAppendQuick: (input: NoteAppendQuickInput) =>
    command<NoteRecord>("note_append_quick", { input }),
  noteUpsertMinutes: (input: NoteUpsertMinutesInput) =>
    command<NoteRecord>("note_upsert_minutes", { input }),
  conclusionCreate: (input: ConclusionCreateInput) =>
    command<ConclusionRecord>("conclusion_create", { input }),
  conclusionList: (input: ConclusionListInput) =>
    command<ConclusionRecord[]>("conclusion_list", { input }),
  conclusionUpdate: (input: ConclusionUpdateInput) =>
    command<ConclusionRecord>("conclusion_update", { input }),
  todoCreate: (input: TodoCreateInput) =>
    command<TodoRecord>("todo_create", { input }),
  todoUpdateStatus: (input: TodoUpdateStatusInput) =>
    command<TodoRecord>("todo_update_status", { input }),
  todoAddProgress: (input: TodoAddProgressInput) =>
    command<TodoProgressRecord>("todo_add_progress", { input }),
  todoListOpen: (input: ProjectIdInput) =>
    command<TodoRecord[]>("todo_list_open", { input }),
  documentImport: (input: DocumentImportInput) =>
    command<DocumentRecord>("document_import", { input }),
  documentUpdateMeta: (input: DocumentUpdateMetaInput) =>
    command<DocumentRecord>("document_update_meta", { input }),
  documentRelocate: (input: DocumentRelocateInput) =>
    command<DocumentRecord>("document_relocate", { input }),
  aiGenerateNoteSuggestions: (input: AiGenerateInput) =>
    command<AiSuggestionRecord[]>("ai_generate_note_suggestions", { input }),
  aiAcceptSuggestion: (input: AiAcceptSuggestionInput) =>
    command<AcceptedSuggestionResult>("ai_accept_suggestion", { input }),
  workspaceSearch: (input: WorkspaceSearchInput) =>
    command<WorkspaceSearchResult[]>("workspace_search", { input }),
};

export async function pickDirectory() {
  const selected = await open({
    directory: true,
    multiple: false,
  });
  return Array.isArray(selected) ? selected[0] ?? null : selected;
}

export async function pickFile() {
  const selected = await open({
    directory: false,
    multiple: false,
  });
  return Array.isArray(selected) ? selected[0] ?? null : selected;
}

export async function revealPath(path: string) {
  return openPath(path);
}
