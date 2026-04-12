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
  AiAnswerQuestionInput,
  AiAnswerResult,
  AiArtifactGetInput,
  AiArtifactRecord,
  AiCapabilityBindingRecord,
  AiCapabilityBindingUpsertInput,
  AiExecutionSettings,
  AiFeatureSettings,
  AiFeatureSettingsUpsertInput,
  AiGenerateInput,
  AiJobEnqueueInput,
  AiJobSnapshot,
  AiProfileTestInput,
  AiProfileTestResult,
  AiProviderProfileDeleteInput,
  AiProviderProfileRecord,
  AiProviderProfileUpsertInput,
  AiSettingsSnapshot,
  AiSuggestionRecord,
  ConclusionCreateInput,
  ConclusionDeleteInput,
  ConclusionListInput,
  ConclusionRecord,
  ConclusionUpdateInput,
  DocumentAddVersionInput,
  DocumentDeleteInput,
  DocumentImportClipboardImageInput,
  DocumentImportClipboardNoteImageInput,
  DocumentImportInput,
  DocumentImportNoteImageInput,
  DocumentListVersionsInput,
  DocumentRecord,
  DocumentRelocateInput,
  DocumentUpdateMetaInput,
  DocumentVersionRecord,
  FileTagOptionDeleteInput,
  FileTagOptionUpsertInput,
  FileTagRecord,
  FileTagSettingsSnapshot,
  NoteDeleteInput,
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
  RecordTypeOptionDeleteInput,
  RecordTypeOptionUpsertInput,
  RecordTypeRecord,
  RecordTypeSettingsSnapshot,
  RichTextStyleSettings,
  RichTextStyleUpsertInput,
  TodoAddProgressInput,
  TodoCreateInput,
  TodoDeleteInput,
  TodoProgressRecord,
  TodoRecord,
  TodoUpdateContentInput,
  TodoUpdatePriorityInput,
  TodoUpdateStatusInput,
  WorkspaceNoteDeleteInput,
  WorkspaceNoteRecord,
  WorkspaceNoteUpsertInput,
  WorkspaceCreateInput,
  WorkspaceOpenInput,
  WorkspaceSearchInput,
  WorkspaceSearchResult,
  WorkspaceStatusSnapshot,
  WorkspaceUnlockInput,
} from "../lib/types";

export const projectMindApi = {
  workspaceStatusGet: () =>
    desktopApi.command<WorkspaceStatusSnapshot>("workspace_status_get"),
  workspaceCreate: (input: WorkspaceCreateInput) =>
    desktopApi.command<WorkspaceStatusSnapshot>("workspace_create", { input }),
  workspaceOpen: (input: WorkspaceOpenInput) =>
    desktopApi.command<WorkspaceStatusSnapshot>("workspace_open", { input }),
  workspaceUnlock: (input: WorkspaceUnlockInput) =>
    desktopApi.command<WorkspaceStatusSnapshot>("workspace_unlock", { input }),
  workspaceLock: () =>
    desktopApi.command<WorkspaceStatusSnapshot>("workspace_lock"),
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
    desktopApi.command<ActivityAttributeOption>(
      "activity_attribute_option_upsert",
      { input },
    ),
  activityAttributeOptionDelete: (input: ActivityOptionDeleteInput) =>
    desktopApi.command<ActivitySettingsSnapshot>(
      "activity_attribute_option_delete",
      { input },
    ),
  activityStatusOptionUpsert: (input: ActivityStatusOptionUpsertInput) =>
    desktopApi.command<ActivityStatusOption>("activity_status_option_upsert", {
      input,
    }),
  activityStatusOptionDelete: (input: ActivityOptionDeleteInput) =>
    desktopApi.command<ActivitySettingsSnapshot>(
      "activity_status_option_delete",
      { input },
    ),
  fileTagSettingsGet: () =>
    desktopApi.command<FileTagSettingsSnapshot>("file_tag_settings_get"),
  fileTagOptionUpsert: (input: FileTagOptionUpsertInput) =>
    desktopApi.command<FileTagRecord>("file_tag_option_upsert", { input }),
  fileTagOptionDelete: (input: FileTagOptionDeleteInput) =>
    desktopApi.command<FileTagSettingsSnapshot>("file_tag_option_delete", {
      input,
    }),
  recordTypeSettingsGet: () =>
    desktopApi.command<RecordTypeSettingsSnapshot>("record_type_settings_get"),
  recordTypeOptionUpsert: (input: RecordTypeOptionUpsertInput) =>
    desktopApi.command<RecordTypeRecord>("record_type_option_upsert", {
      input,
    }),
  recordTypeOptionDelete: (input: RecordTypeOptionDeleteInput) =>
    desktopApi.command<RecordTypeSettingsSnapshot>(
      "record_type_option_delete",
      { input },
    ),
  noteUpsert: (input: NoteUpsertInput) =>
    desktopApi.command<NoteRecord>("note_upsert", { input }),
  noteDelete: (input: NoteDeleteInput) =>
    desktopApi.command<NoteRecord>("note_delete", { input }),
  conclusionCreate: (input: ConclusionCreateInput) =>
    desktopApi.command<ConclusionRecord>("conclusion_create", { input }),
  conclusionList: (input: ConclusionListInput) =>
    desktopApi.command<ConclusionRecord[]>("conclusion_list", { input }),
  conclusionUpdate: (input: ConclusionUpdateInput) =>
    desktopApi.command<ConclusionRecord>("conclusion_update", { input }),
  conclusionDelete: (input: ConclusionDeleteInput) =>
    desktopApi.command<ConclusionRecord>("conclusion_delete", { input }),
  todoCreate: (input: TodoCreateInput) =>
    desktopApi.command<TodoRecord>("todo_create", { input }),
  todoUpdateContent: (input: TodoUpdateContentInput) =>
    desktopApi.command<TodoRecord>("todo_update_content", { input }),
  todoUpdatePriority: (input: TodoUpdatePriorityInput) =>
    desktopApi.command<TodoRecord>("todo_update_priority", { input }),
  todoUpdateStatus: (input: TodoUpdateStatusInput) =>
    desktopApi.command<TodoRecord>("todo_update_status", { input }),
  todoAddProgress: (input: TodoAddProgressInput) =>
    desktopApi.command<TodoProgressRecord>("todo_add_progress", { input }),
  todoDelete: (input: TodoDeleteInput) =>
    desktopApi.command<TodoRecord>("todo_delete", { input }),
  todoListOpen: (input: ProjectIdInput) =>
    desktopApi.command<TodoRecord[]>("todo_list_open", { input }),
  workspaceTodoList: () =>
    desktopApi.command<TodoRecord[]>("workspace_todo_list"),
  workspaceNoteList: () =>
    desktopApi.command<WorkspaceNoteRecord[]>("workspace_note_list"),
  workspaceNoteUpsert: (input: WorkspaceNoteUpsertInput) =>
    desktopApi.command<WorkspaceNoteRecord>("workspace_note_upsert", { input }),
  workspaceNoteDelete: (input: WorkspaceNoteDeleteInput) =>
    desktopApi.command<WorkspaceNoteRecord>("workspace_note_delete", { input }),
  documentImport: (input: DocumentImportInput) =>
    desktopApi.command<DocumentRecord>("document_import", { input }),
  documentImportClipboardImage: (input: DocumentImportClipboardImageInput) =>
    desktopApi.command<DocumentRecord>("document_import_clipboard_image", {
      input,
    }),
  documentImportNoteImage: (input: DocumentImportNoteImageInput) =>
    desktopApi.command<DocumentRecord>("document_import_note_image", { input }),
  documentImportClipboardNoteImage: (
    input: DocumentImportClipboardNoteImageInput,
  ) =>
    desktopApi.command<DocumentRecord>("document_import_clipboard_note_image", {
      input,
    }),
  documentUpdateMeta: (input: DocumentUpdateMetaInput) =>
    desktopApi.command<DocumentRecord>("document_update_meta", { input }),
  documentRelocate: (input: DocumentRelocateInput) =>
    desktopApi.command<DocumentRecord>("document_relocate", { input }),
  documentListVersions: (input: DocumentListVersionsInput) =>
    desktopApi.command<DocumentVersionRecord[]>("document_list_versions", {
      input,
    }),
  documentAddVersion: (input: DocumentAddVersionInput) =>
    desktopApi.command<DocumentRecord>("document_add_version", { input }),
  documentDelete: (input: DocumentDeleteInput) =>
    desktopApi.command<DocumentRecord>("document_delete", { input }),
  aiGenerateNoteSuggestions: (input: AiGenerateInput) =>
    desktopApi.command<AiSuggestionRecord[]>("ai_generate_note_suggestions", {
      input,
    }),
  aiAcceptSuggestion: (input: AiAcceptSuggestionInput) =>
    desktopApi.command<AcceptedSuggestionResult>("ai_accept_suggestion", {
      input,
    }),
  aiArtifactGet: (input: AiArtifactGetInput) =>
    desktopApi.command<AiArtifactRecord | null>("ai_artifact_get", { input }),
  aiArtifactRefresh: (input: AiArtifactGetInput) =>
    desktopApi.command<AiArtifactRecord>("ai_artifact_refresh", { input }),
  aiAnswerQuestion: (input: AiAnswerQuestionInput) =>
    desktopApi.command<AiAnswerResult>("ai_answer_question", { input }),
  aiSettingsGet: () =>
    desktopApi.command<AiSettingsSnapshot>("ai_settings_get"),
  richTextStyleGet: () =>
    desktopApi.command<RichTextStyleSettings>("rich_text_style_get"),
  richTextStyleUpsert: (input: RichTextStyleUpsertInput) =>
    desktopApi.command<RichTextStyleSettings>("rich_text_style_upsert", {
      input,
    }),
  aiProfileUpsert: (input: AiProviderProfileUpsertInput) =>
    desktopApi.command<AiProviderProfileRecord>("ai_profile_upsert", { input }),
  aiProfileDelete: (input: AiProviderProfileDeleteInput) =>
    desktopApi.command<AiSettingsSnapshot>("ai_profile_delete", { input }),
  aiProfileTest: (input: AiProfileTestInput) =>
    desktopApi.command<AiProfileTestResult>("ai_profile_test", { input }),
  aiBindingUpsert: (input: AiCapabilityBindingUpsertInput) =>
    desktopApi.command<AiCapabilityBindingRecord>("ai_binding_upsert", {
      input,
    }),
  aiFeatureSettingsUpsert: (input: AiFeatureSettingsUpsertInput) =>
    desktopApi.command<AiFeatureSettings>("ai_feature_settings_upsert", {
      input,
    }),
  aiJobEnqueue: (input: AiJobEnqueueInput) =>
    desktopApi.command<AiJobSnapshot>("ai_job_enqueue", { input }),
  aiJobGet: (jobId: number) =>
    desktopApi.command<AiJobSnapshot | null>("ai_job_get", { jobId }),
  aiJobsListActive: () =>
    desktopApi.command<AiJobSnapshot[]>("ai_jobs_list_active"),
  aiExecutionSettingsUpsert: (input: AiExecutionSettings) =>
    desktopApi.command<AiExecutionSettings>("ai_execution_settings_upsert", {
      input,
    }),
  workspaceSearch: (input: WorkspaceSearchInput) =>
    desktopApi.command<WorkspaceSearchResult[]>("workspace_search", { input }),
};
