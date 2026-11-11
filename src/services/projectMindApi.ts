import type { AgentWorkspaceBinding } from "../lib/agent-types";
import { recordDocumentApi } from "./recordDocumentApi";
import { desktopApi } from "./desktopApi";
import { callAgentCommand } from "./agentApi";
import type {
  AiCapabilityBindingRecord,
  AiCapabilityBindingUpsertInput,
  AiEditorSkillDeleteInput,
  AiEditorSkillRecord,
  AiEditorSkillReorderInput,
  AiEditorSkillUpsertInput,
  AiExecutionSettings,
  AiJobEnqueueInput,
  AiJobIdentity,
  AiJobSnapshot,
  AiNetworkSettings,
  AiNetworkSettingsUpsertInput,
  AiProfileTestInput,
  AiProfileTestResult,
  AiProviderProfileDeleteInput,
  AiProviderProfileRecord,
  AiProviderProfileUpsertInput,
  AiSettingsSnapshot,
  ContactDeleteInput,
  ContactRecord,
  ContactSearchInput,
  ContactUpsertInput,
  DocumentAddVersionInput,
  DocumentVersionPrepareInput,
  PreparedDocumentVersion,
  DocumentVersionCommitResult,
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
  ProjectRecordMetadataApplyInput,
  NoteRecord,
  ProjectRecordUpsertInput,
  ProjectQuickNoteCommitInput,
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
  WorkspaceQuickNoteCommitInput,
  WorkspacePageData,
  WorkspaceClipboardNoteImageImportInput,
  WorkspaceNoteImageAsset,
  WorkspaceNoteImageImportInput,
  WorkspaceRecordDeleteInput,
  WorkspaceRecordMetadataApplyInput,
  WorkspaceRecord,
  WorkspaceRecordUpsertInput,
  WorkspaceCreateInput,
  WorkspaceOpenInput,
  WorkspaceSearchInput,
  WorkspaceSearchResult,
  WorkspaceStatusSnapshot,
} from "../lib/types";

export const projectMindApi = {
  workspaceBindingGet: (workspaceRoot: string) => recordDocumentApi.bindingGet(workspaceRoot),
  workspaceStatusGet: () =>
    desktopApi.command<WorkspaceStatusSnapshot>("workspace_status_get"),
  workspaceCreate: (input: WorkspaceCreateInput) =>
    desktopApi.command<WorkspaceStatusSnapshot>("workspace_create", { input }),
  workspaceOpen: (input: WorkspaceOpenInput) =>
    desktopApi.command<WorkspaceStatusSnapshot>("workspace_open", { input }),
  workspaceClose: () =>
    desktopApi.command<WorkspaceStatusSnapshot>("workspace_close"),
  projectsList: (input: ProjectsListInput = {}, binding?: AgentWorkspaceBinding) =>
    desktopApi.command<ProjectListItem[]>("projects_list", { input, ...(binding ? { binding } : {}) }),
  projectCreate: (input: ProjectCreateInput) =>
    desktopApi.command<ProjectRecord>("project_create", { input }),
  projectPageGet: (input: ProjectIdInput, binding?: AgentWorkspaceBinding) =>
    desktopApi.command<ProjectPageData>("project_page_get", { input, ...(binding ? { binding } : {}) }),
  workspacePageGet: (binding?: AgentWorkspaceBinding) =>
    desktopApi.command<WorkspacePageData>("workspace_page_get", ...(binding ? [{ binding }] : [])),
  projectUpdate: (input: ProjectUpdateInput) =>
    desktopApi.command<ProjectRecord>("project_update", { input }),
  projectSetArchive: (input: ProjectArchiveInput) =>
    desktopApi.command<ProjectRecord>("project_set_archive", { input }),
  projectDelete: (input: ProjectDeleteInput) =>
    desktopApi.command<ProjectRecord>("project_delete", { input }),
  projectTagSettingsGet: (input: ProjectTagSettingsGetInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<ProjectTagSettingsSnapshot>("file_tag_settings_get", { input, binding }),
  projectTagUpsert: (input: ProjectTagUpsertInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<ProjectTagRecord>("file_tag_option_upsert", { input, binding }),
  projectTagDelete: (input: ProjectTagDeleteInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<ProjectTagSettingsSnapshot>("file_tag_option_delete", {
      input, binding,
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
  projectQuickNoteCommit: (input: ProjectQuickNoteCommitInput) =>
    desktopApi.command<NoteRecord>("project_quick_note_commit", { input }),
  projectRecordMetadataApply: (input: ProjectRecordMetadataApplyInput) =>
    desktopApi.command<NoteRecord>("project_record_metadata_apply", { input }),
  projectRecordDelete: (input: ProjectRecordDeleteInput) =>
    desktopApi.command<NoteRecord>("project_record_delete", { input }),
  todoCreate: (input: TodoCreateInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoRecord>("todo_create", { input, binding }),
  todoUpdateContent: (input: TodoUpdateContentInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoRecord>("todo_update_content", { input, binding }),
  todoUpdateTags: (input: TodoUpdateTagsInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoRecord>("todo_update_tags", { input, binding }),
  todoUpdatePriority: (input: TodoUpdatePriorityInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoRecord>("todo_update_priority", { input, binding }),
  todoUpdateStatus: (input: TodoUpdateStatusInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoRecord>("todo_update_status", { input, binding }),
  todoAddProgress: (input: TodoAddProgressInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoProgressRecord>("todo_add_progress", { input, binding }),
  todoUpdateProgress: (input: TodoUpdateProgressInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoProgressRecord>("todo_update_progress", { input, binding }),
  todoDeleteProgress: (input: TodoDeleteProgressInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoProgressRecord>("todo_delete_progress", { input, binding }),
  todoDelete: (input: TodoDeleteInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoRecord>("todo_delete", { input, binding }),
  todoListOpen: (input: ProjectIdInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<TodoRecord[]>("todo_list_open", { input, binding }),
  workspaceQuickNoteGet: () =>
    desktopApi.command<WorkspaceRecord | null>("workspace_quick_note_get"),
  workspaceQuickNoteUpsert: (input: WorkspaceQuickNoteUpsertInput) =>
    desktopApi.command<WorkspaceRecord>("workspace_quick_note_upsert", { input }),
  workspaceQuickNoteCommit: (input: WorkspaceQuickNoteCommitInput) =>
    desktopApi.command<WorkspaceRecord>("workspace_quick_note_commit", { input }),
  workspaceRecordList: () =>
    desktopApi.command<WorkspaceRecord[]>("workspace_record_list"),
  workspaceRecordUpsert: (input: WorkspaceRecordUpsertInput) =>
    desktopApi.command<WorkspaceRecord>("workspace_record_upsert", { input }),
  workspaceRecordMetadataApply: (input: WorkspaceRecordMetadataApplyInput) =>
    desktopApi.command<WorkspaceRecord>("workspace_record_metadata_apply", { input }),
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
  documentImport: (input: DocumentImportInput, binding?: AgentWorkspaceBinding) =>
    desktopApi.command<DocumentRecord>("document_import", { input, ...(binding ? { binding } : {}) }),
  documentImportClipboardImage: (input: DocumentImportClipboardImageInput, binding?: AgentWorkspaceBinding) =>
    desktopApi.command<DocumentRecord>("document_import_clipboard_image", {
      input, ...(binding ? { binding } : {}),
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
  documentVersionPrepare: (input: DocumentVersionPrepareInput, requestId = crypto.randomUUID()) =>
    callAgentCommand<PreparedDocumentVersion>("document_version_prepare", requestId, { input, requestId }),
  documentAddVersion: (input: DocumentAddVersionInput) =>
    callAgentCommand<DocumentVersionCommitResult>("document_add_version", input.requestId, { input }),
  documentDelete: (input: DocumentDeleteInput) =>
    desktopApi.command<DocumentRecord>("document_delete", { input }),
  aiSettingsGet: () =>
    desktopApi.command<AiSettingsSnapshot>("ai_settings_get"),
  aiNetworkSettingsUpsert: (input: AiNetworkSettingsUpsertInput) =>
    desktopApi.command<AiNetworkSettings>("ai_network_settings_upsert", { input }),
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
  aiJobBindingGet: () =>
    desktopApi.command<AgentWorkspaceBinding>("ai_job_binding_get"),
  aiJobEnqueue: (input: AiJobEnqueueInput, binding: AgentWorkspaceBinding) =>
    desktopApi.command<AiJobSnapshot>("ai_job_enqueue", { input, binding }),
  aiJobGet: ({ id: jobId, binding }: AiJobIdentity) =>
    desktopApi.command<AiJobSnapshot | null>("ai_job_get", { jobId, binding }),
  aiJobCancel: ({ id: jobId, binding }: AiJobIdentity) =>
    desktopApi.command<AiJobSnapshot | null>("ai_job_cancel", { jobId, binding }),
  aiImageTargetSignature: (input: { path: string; annotationState?: string | null }) =>
    desktopApi.command<string>("ai_image_target_signature", {
      path: input.path,
      annotationState: input.annotationState ?? null,
    }),
  aiJobsListActive: (binding: AgentWorkspaceBinding) =>
    desktopApi.command<AiJobSnapshot[]>("ai_jobs_list_active", { binding }),
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
