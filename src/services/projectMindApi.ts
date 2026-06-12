import { desktopApi } from "./desktopApi";
import type {
  AcceptedSuggestionResult,
  AiAcceptSuggestionInput,
  AiAnswerQuestionInput,
  AiAnswerResult,
  AiArtifactGetInput,
  AiArtifactRecord,
  AiCapabilityBindingRecord,
  AiCapabilityBindingUpsertInput,
  AiEditorRewriteActionDeleteInput,
  AiEditorRewriteActionRecord,
  AiEditorRewriteActionUpsertInput,
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
  ContactDeleteInput,
  ContactRecord,
  ContactSearchInput,
  ContactUpsertInput,
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
  FileTagSettingsGetInput,
  FileTagOptionUpsertInput,
  FileTagRecord,
  FileTagSettingsSnapshot,
  InternalReferenceResolveInput,
  InternalReferenceResolveResult,
  InternalReferenceSearchInput,
  InternalReferenceSearchResult,
  ProjectRecordDeleteInput,
  NoteRecord,
  ProjectRecordUpsertInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectIdInput,
  ProjectListItem,
  ProjectPageData,
  ProjectRecord,
  ProjectUpdateInput,
  ProjectsListInput,
  RichTextStyleSettings,
  RichTextStyleUpsertInput,
  TodoAddProgressInput,
  TodoCreateInput,
  TodoDeleteInput,
  TodoDeleteProgressInput,
  TodoProgressRecord,
  TodoRecord,
  TodoUpdateContentInput,
  TodoUpdateProgressInput,
  TodoUpdatePriorityInput,
  TodoUpdateStatusInput,
  TodoUpdateTagsInput,
  WorkspaceQuickNoteUpsertInput,
  WorkspacePageData,
  WorkspaceRecordDeleteInput,
  WorkspaceRecord,
  WorkspaceRecordUpsertInput,
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
  projectPageGet: (input: ProjectIdInput) =>
    desktopApi.command<ProjectPageData>("project_page_get", { input }),
  workspacePageGet: () =>
    desktopApi.command<WorkspacePageData>("workspace_page_get"),
  projectUpdate: (input: ProjectUpdateInput) =>
    desktopApi.command<ProjectRecord>("project_update", { input }),
  projectSetArchive: (input: ProjectArchiveInput) =>
    desktopApi.command<ProjectRecord>("project_set_archive", { input }),
  fileTagSettingsGet: (input: FileTagSettingsGetInput) =>
    desktopApi.command<FileTagSettingsSnapshot>("file_tag_settings_get", { input }),
  fileTagOptionUpsert: (input: FileTagOptionUpsertInput) =>
    desktopApi.command<FileTagRecord>("file_tag_option_upsert", { input }),
  fileTagOptionDelete: (input: FileTagOptionDeleteInput) =>
    desktopApi.command<FileTagSettingsSnapshot>("file_tag_option_delete", {
      input,
    }),
  contactList: () => desktopApi.command<ContactRecord[]>("contact_list"),
  contactSearch: (input: ContactSearchInput) =>
    desktopApi.command<ContactRecord[]>("contact_search", { input }),
  contactUpsert: (input: ContactUpsertInput) =>
    desktopApi.command<ContactRecord>("contact_upsert", { input }),
  contactDelete: (input: ContactDeleteInput) =>
    desktopApi.command<ContactRecord>("contact_delete", { input }),
  projectRecordUpsert: (input: ProjectRecordUpsertInput) =>
    desktopApi.command<NoteRecord>("project_record_upsert", { input }),
  projectRecordDelete: (input: ProjectRecordDeleteInput) =>
    desktopApi.command<NoteRecord>("project_record_delete", { input }),
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
  todoUpdateTags: (input: TodoUpdateTagsInput) =>
    desktopApi.command<TodoRecord>("todo_update_tags", { input }),
  todoUpdatePriority: (input: TodoUpdatePriorityInput) =>
    desktopApi.command<TodoRecord>("todo_update_priority", { input }),
  todoUpdateStatus: (input: TodoUpdateStatusInput) =>
    desktopApi.command<TodoRecord>("todo_update_status", { input }),
  todoAddProgress: (input: TodoAddProgressInput) =>
    desktopApi.command<TodoProgressRecord>("todo_add_progress", { input }),
  todoUpdateProgress: (input: TodoUpdateProgressInput) =>
    desktopApi.command<TodoProgressRecord>("todo_update_progress", { input }),
  todoDeleteProgress: (input: TodoDeleteProgressInput) =>
    desktopApi.command<TodoProgressRecord>("todo_delete_progress", { input }),
  todoDelete: (input: TodoDeleteInput) =>
    desktopApi.command<TodoRecord>("todo_delete", { input }),
  todoListOpen: (input: ProjectIdInput) =>
    desktopApi.command<TodoRecord[]>("todo_list_open", { input }),
  workspaceTodoList: () =>
    desktopApi.command<TodoRecord[]>("workspace_todo_list"),
  workspaceQuickNoteGet: () =>
    desktopApi.command<WorkspaceRecord | null>("workspace_quick_note_get"),
  workspaceQuickNoteUpsert: (input: WorkspaceQuickNoteUpsertInput) =>
    desktopApi.command<WorkspaceRecord>("workspace_quick_note_upsert", { input }),
  workspaceRecordList: () =>
    desktopApi.command<WorkspaceRecord[]>("workspace_record_list"),
  workspaceRecordUpsert: (input: WorkspaceRecordUpsertInput) =>
    desktopApi.command<WorkspaceRecord>("workspace_record_upsert", { input }),
  workspaceRecordDelete: (input: WorkspaceRecordDeleteInput) =>
    desktopApi.command<WorkspaceRecord>("workspace_record_delete", { input }),
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
  aiEditorRewriteActionUpsert: (input: AiEditorRewriteActionUpsertInput) =>
    desktopApi.command<AiEditorRewriteActionRecord>(
      "ai_editor_rewrite_action_upsert",
      {
        input,
      },
    ),
  aiEditorRewriteActionDelete: (input: AiEditorRewriteActionDeleteInput) =>
    desktopApi.command<AiEditorRewriteActionRecord[]>(
      "ai_editor_rewrite_action_delete",
      {
        input,
      },
    ),
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
  internalReferenceSearch: (input: InternalReferenceSearchInput) =>
    desktopApi.command<InternalReferenceSearchResult[]>("internal_reference_search", {
      input,
    }),
  internalReferenceResolve: (input: InternalReferenceResolveInput) =>
    desktopApi.command<InternalReferenceResolveResult | null>("internal_reference_resolve", {
      input,
    }),
  workspaceSearch: (input: WorkspaceSearchInput) =>
    desktopApi.command<WorkspaceSearchResult[]>("workspace_search", { input }),
};
