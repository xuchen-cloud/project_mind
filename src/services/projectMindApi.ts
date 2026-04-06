import { desktopApi } from "./desktopApi";
import type {
  AcceptedSuggestionResult,
  ActivityAttributeOption,
  ActivityAttributeOptionUpsertInput,
  ActivityCardData,
  ActivityCreateInput,
  ActivityOptionDeleteInput,
  ActivitySettingsSnapshot,
  ActivityStatusOption,
  ActivityStatusOptionUpsertInput,
  ActivityUpdateMetaInput,
  AiAcceptSuggestionInput,
  AiCapabilityBindingRecord,
  AiCapabilityBindingUpsertInput,
  AiGenerateInput,
  AiProfileTestInput,
  AiProfileTestResult,
  AiProviderProfileDeleteInput,
  AiProviderProfileRecord,
  AiProviderProfileUpsertInput,
  AiSettingsSnapshot,
  AiSuggestionRecord,
  ConclusionCreateInput,
  ConclusionListInput,
  ConclusionRecord,
  ConclusionUpdateInput,
  DocumentAddVersionInput,
  DocumentImportInput,
  DocumentListVersionsInput,
  DocumentRecord,
  DocumentRelocateInput,
  DocumentUpdateMetaInput,
  DocumentVersionRecord,
  NoteRecord,
  NoteUpsertInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDashboard,
  ProjectIdInput,
  ProjectListItem,
  ProjectOverviewData,
  ProjectRecord,
  ProjectUpdateSummaryInput,
  ProjectsListInput,
  RichTextStyleSettings,
  RichTextStyleUpsertInput,
  TodoAddProgressInput,
  TodoCreateInput,
  TodoProgressRecord,
  TodoRecord,
  TodoUpdateContentInput,
  TodoUpdateStatusInput,
  WorkspaceSearchInput,
  WorkspaceSearchResult,
} from "../lib/types";

export const projectMindApi = {
  projectsList: (input: ProjectsListInput = {}) =>
    desktopApi.command<ProjectListItem[]>("projects_list", { input }),
  projectCreate: (input: ProjectCreateInput) =>
    desktopApi.command<ProjectRecord>("project_create", { input }),
  projectGetDashboard: (input: ProjectIdInput) =>
    desktopApi.command<ProjectDashboard>("project_get_dashboard", { input }),
  projectGetOverview: (input: ProjectIdInput) =>
    desktopApi.command<ProjectOverviewData>("project_get_overview", { input }),
  projectUpdateSummary: (input: ProjectUpdateSummaryInput) =>
    desktopApi.command<ProjectRecord>("project_update_summary", { input }),
  projectSetArchive: (input: ProjectArchiveInput) =>
    desktopApi.command<ProjectRecord>("project_set_archive", { input }),
  activityCreate: (input: ActivityCreateInput) =>
    desktopApi.command<ActivityCardData>("activity_create", { input }),
  activityList: (input: ProjectIdInput) =>
    desktopApi.command<ActivityCardData[]>("activity_list", { input }),
  activityUpdateMeta: (input: ActivityUpdateMetaInput) =>
    desktopApi.command<ActivityCardData>("activity_update_meta", { input }),
  activitySettingsGet: () =>
    desktopApi.command<ActivitySettingsSnapshot>("activity_settings_get"),
  activityAttributeOptionUpsert: (input: ActivityAttributeOptionUpsertInput) =>
    desktopApi.command<ActivityAttributeOption>("activity_attribute_option_upsert", { input }),
  activityAttributeOptionDelete: (input: ActivityOptionDeleteInput) =>
    desktopApi.command<ActivitySettingsSnapshot>("activity_attribute_option_delete", { input }),
  activityStatusOptionUpsert: (input: ActivityStatusOptionUpsertInput) =>
    desktopApi.command<ActivityStatusOption>("activity_status_option_upsert", { input }),
  activityStatusOptionDelete: (input: ActivityOptionDeleteInput) =>
    desktopApi.command<ActivitySettingsSnapshot>("activity_status_option_delete", { input }),
  noteUpsert: (input: NoteUpsertInput) =>
    desktopApi.command<NoteRecord>("note_upsert", { input }),
  conclusionCreate: (input: ConclusionCreateInput) =>
    desktopApi.command<ConclusionRecord>("conclusion_create", { input }),
  conclusionList: (input: ConclusionListInput) =>
    desktopApi.command<ConclusionRecord[]>("conclusion_list", { input }),
  conclusionUpdate: (input: ConclusionUpdateInput) =>
    desktopApi.command<ConclusionRecord>("conclusion_update", { input }),
  todoCreate: (input: TodoCreateInput) =>
    desktopApi.command<TodoRecord>("todo_create", { input }),
  todoUpdateContent: (input: TodoUpdateContentInput) =>
    desktopApi.command<TodoRecord>("todo_update_content", { input }),
  todoUpdateStatus: (input: TodoUpdateStatusInput) =>
    desktopApi.command<TodoRecord>("todo_update_status", { input }),
  todoAddProgress: (input: TodoAddProgressInput) =>
    desktopApi.command<TodoProgressRecord>("todo_add_progress", { input }),
  todoListOpen: (input: ProjectIdInput) =>
    desktopApi.command<TodoRecord[]>("todo_list_open", { input }),
  documentImport: (input: DocumentImportInput) =>
    desktopApi.command<DocumentRecord>("document_import", { input }),
  documentUpdateMeta: (input: DocumentUpdateMetaInput) =>
    desktopApi.command<DocumentRecord>("document_update_meta", { input }),
  documentRelocate: (input: DocumentRelocateInput) =>
    desktopApi.command<DocumentRecord>("document_relocate", { input }),
  documentListVersions: (input: DocumentListVersionsInput) =>
    desktopApi.command<DocumentVersionRecord[]>("document_list_versions", { input }),
  documentAddVersion: (input: DocumentAddVersionInput) =>
    desktopApi.command<DocumentRecord>("document_add_version", { input }),
  aiGenerateNoteSuggestions: (input: AiGenerateInput) =>
    desktopApi.command<AiSuggestionRecord[]>("ai_generate_note_suggestions", { input }),
  aiAcceptSuggestion: (input: AiAcceptSuggestionInput) =>
    desktopApi.command<AcceptedSuggestionResult>("ai_accept_suggestion", { input }),
  aiSettingsGet: () => desktopApi.command<AiSettingsSnapshot>("ai_settings_get"),
  richTextStyleGet: () => desktopApi.command<RichTextStyleSettings>("rich_text_style_get"),
  richTextStyleUpsert: (input: RichTextStyleUpsertInput) =>
    desktopApi.command<RichTextStyleSettings>("rich_text_style_upsert", { input }),
  aiProfileUpsert: (input: AiProviderProfileUpsertInput) =>
    desktopApi.command<AiProviderProfileRecord>("ai_profile_upsert", { input }),
  aiProfileDelete: (input: AiProviderProfileDeleteInput) =>
    desktopApi.command<AiSettingsSnapshot>("ai_profile_delete", { input }),
  aiProfileTest: (input: AiProfileTestInput) =>
    desktopApi.command<AiProfileTestResult>("ai_profile_test", { input }),
  aiBindingUpsert: (input: AiCapabilityBindingUpsertInput) =>
    desktopApi.command<AiCapabilityBindingRecord>("ai_binding_upsert", { input }),
  workspaceSearch: (input: WorkspaceSearchInput) =>
    desktopApi.command<WorkspaceSearchResult[]>("workspace_search", { input }),
};
