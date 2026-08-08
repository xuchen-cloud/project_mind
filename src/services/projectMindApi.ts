import { desktopApi } from "./desktopApi";
import type {
  AiCapabilityBindingRecord,
  AiCapabilityBindingUpsertInput,
  AiEditorSkillDeleteInput,
  AiEditorSkillRecord,
  AiEditorSkillReorderInput,
  AiEditorSkillUpsertInput,
  AiExecutionSettings,
  AiJobEnqueueInput,
  AiJobSnapshot,
  AiProfileTestInput,
  AiProfileTestResult,
  AiProviderProfileDeleteInput,
  AiProviderProfileRecord,
  AiProviderProfileUpsertInput,
  AiSettingsSnapshot,
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
  ProjectTagDeleteInput,
  ProjectTagSettingsGetInput,
  ProjectTagUpsertInput,
  ProjectTagRecord,
  ProjectTagSettingsSnapshot,
  InternalReferenceResolveInput,
  InternalReferenceResolveResult,
  InternalReferenceSearchInput,
  InternalReferenceSearchResult,
  ProjectRecordDeleteInput,
  NoteRecord,
  ProjectRecordUpsertInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDeleteInput,
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
  WorkspaceClipboardNoteImageImportInput,
  WorkspaceNoteImageAsset,
  WorkspaceNoteImageImportInput,
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
  projectDelete: (input: ProjectDeleteInput) =>
    desktopApi.command<ProjectRecord>("project_delete", { input }),
  projectTagSettingsGet: (input: ProjectTagSettingsGetInput) =>
    desktopApi.command<ProjectTagSettingsSnapshot>("file_tag_settings_get", { input }),
  projectTagUpsert: (input: ProjectTagUpsertInput) =>
    desktopApi.command<ProjectTagRecord>("file_tag_option_upsert", { input }),
  projectTagDelete: (input: ProjectTagDeleteInput) =>
    desktopApi.command<ProjectTagSettingsSnapshot>("file_tag_option_delete", {
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
  workspaceNoteImageImport: (input: WorkspaceNoteImageImportInput) =>
    desktopApi.command<WorkspaceNoteImageAsset>("workspace_note_image_import", {
      input,
    }),
  workspaceClipboardNoteImageImport: (
    input: WorkspaceClipboardNoteImageImportInput,
  ) =>
    desktopApi.command<WorkspaceNoteImageAsset>(
      "workspace_clipboard_note_image_import",
      { input },
    ),
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
  aiEditorSkillUpsert: (input: AiEditorSkillUpsertInput) =>
    desktopApi.command<AiEditorSkillRecord>("ai_editor_skill_upsert", {
      input,
    }),
  aiEditorSkillDelete: (input: AiEditorSkillDeleteInput) =>
    desktopApi.command<AiEditorSkillRecord[]>("ai_editor_skill_delete", {
      input,
    }),
  aiEditorSkillReorder: (input: AiEditorSkillReorderInput) =>
    desktopApi.command<AiEditorSkillRecord[]>("ai_editor_skill_reorder", {
      input,
    }),
  aiJobEnqueue: (input: AiJobEnqueueInput) =>
    desktopApi.command<AiJobSnapshot>("ai_job_enqueue", { input }),
  aiJobGet: (jobId: number) =>
    desktopApi.command<AiJobSnapshot | null>("ai_job_get", { jobId }),
  aiJobCancel: (jobId: number) =>
    desktopApi.command<AiJobSnapshot | null>("ai_job_cancel", { jobId }),
  aiImageTargetSignature: (input: { path: string; annotationState?: string | null }) =>
    desktopApi.command<string>("ai_image_target_signature", {
      path: input.path,
      annotationState: input.annotationState ?? null,
    }),
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
