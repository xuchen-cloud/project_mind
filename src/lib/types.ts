export interface ProjectRecord {
  id: number;
  name: string;
  kind: "normal";
  status: string;
  rootPath: string;
  quickNote: string;
  quickNoteMarkdown?: string;
  quickNoteHtml?: string;
  quickNoteCodeLanguage?: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem extends ProjectRecord {
  openTodoCount: number;
}

export interface NoteRecord {
  id: number;
  projectId: number;
  title?: string | null;
  contentMarkdown: string;
  contentHtml: string;
  defaultCodeLanguage?: string | null;
  tags?: DocumentTagRecord[];
  createdAt: string;
  updatedAt: string;
}

export type TodoStatus = "unfinished" | "finished";
export type TodoScope = "workspace" | "project";
export type TodoPriority =
  | "urgent_important"
  | "urgent_not_important"
  | "not_urgent_important"
  | "not_urgent_not_important";

export interface TodoProgressRecord {
  id: number;
  todoId: number;
  content: string;
  progressDate: string;
  dueDate?: string | null;
  status?: TodoStatus;
  completedAt?: string | null;
  orderIndex?: number;
  createdAt: string;
}

export interface TodoRecord {
  id: number;
  scope: TodoScope;
  projectId: number | null;
  projectName?: string | null;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  dueDate?: string | null;
  tags?: DocumentTagRecord[];
  createdAt: string;
  updatedAt: string;
  progresses: TodoProgressRecord[];
}

export interface WorkspaceRecord {
  id: number;
  title?: string | null;
  contentMarkdown: string;
  contentHtml: string;
  defaultCodeLanguage?: string | null;
  tags?: DocumentTagRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRecord {
  id: number;
  projectId: number;
  name: string;
  baseName: string;
  originalPath: string;
  managedPath: string;
  historyDirPath: string;
  storageMode: string;
  mimeType: string;
  isStarred: boolean;
  currentVersionNumber: number;
  versionCount: number;
  health: "normal" | "missing";
  tags: DocumentTagRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersionRecord {
  id: number;
  documentId: number;
  versionNumber: number;
  name: string;
  sourcePath: string;
  managedPath: string;
  createdAt: string;
}

export type TagColorKey =
  | "slate"
  | "blue"
  | "teal"
  | "green"
  | "amber"
  | "orange"
  | "red"
  | "rose";

export interface DocumentTagRecord {
  id: number;
  label: string;
  colorKey: TagColorKey;
}

export interface ProjectTagRecord {
  id: number;
  label: string;
  colorKey: TagColorKey;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectTagSettingsSnapshot {
  tags: ProjectTagRecord[];
}

export interface ProjectRecordGroup {
  groupKey: string;
  groupTitle: string;
  notes: NoteRecord[];
}

export interface ContactRecord {
  id: number;
  name: string;
  pinyinFull: string;
  pinyinAbbr: string;
  email: string;
  employeeId: string;
  role: string;
  department: string;
  createdAt: string;
  updatedAt: string;
}

export type AiJobKind =
  | "profile_test"
  | "editor_skill";

export type AiJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AiExecutionSettings {
  maxConcurrency: 1 | 2 | 3 | 4;
}

export interface AiJobBase {
  kind: AiJobKind;
}

export interface AiProfileTestJobResult extends AiJobBase {
  kind: "profile_test";
  testResult: AiProfileTestResult;
}

export interface AiEditorSkillResult {
  skillId?: string | null;
  resultMode: AiEditorSkillResultMode;
  content: string;
  replacementMarkdown?: string | null;
  answerMarkdown?: string | null;
  resolvedModel?: string | null;
  resolvedProfileName?: string | null;
  usedDefaultFallback: boolean;
  parseError?: string | null;
}

export interface AiEditorSkillJobResult extends AiJobBase {
  kind: "editor_skill";
  rewrite: AiEditorSkillResult;
}

export type AiJobResult =
  | AiProfileTestJobResult
  | AiEditorSkillJobResult;

export interface AiJobSnapshot {
  id: number;
  kind: AiJobKind;
  targetKey: string;
  status: AiJobStatus;
  queuedAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  errorMessage?: string | null;
  streamText?: string | null;
  result?: AiJobResult | null;
}

export interface AiProfileTestJobInput {
  kind: "profile_test";
  targetKey: string;
  input: AiProfileTestInput;
}

export interface AiEditorSkillInput {
  skillId?: string | null;
  skillName?: string | null;
  prompt?: string | null;
  resultMode: AiEditorSkillResultMode;
  selectedText: string;
  expandedMarkdown?: string | null;
  placeholderTokens?: string[];
  documentContext?: string | null;
  targetType?: "text" | "image";
  imageTarget?: AiEditorImageTarget | null;
}

export interface AiEditorSkillJobInput {
  kind: "editor_skill";
  targetKey: string;
  input: AiEditorSkillInput;
}

export type AiJobEnqueueInput =
  | AiProfileTestJobInput
  | AiEditorSkillJobInput;

export interface ProjectPageData {
  project: ProjectRecord;
  projectDocuments: DocumentRecord[];
  recordGroups?: ProjectRecordGroup[];
  records?: NoteRecord[];
  unfinishedTodos: TodoRecord[];
  finishedTodos: TodoRecord[];
}

export interface WorkspacePageData {
  quickNote: WorkspaceRecord | null;
  records: WorkspaceRecord[];
  unfinishedTodos: TodoRecord[];
  finishedTodos: TodoRecord[];
}

export type InternalReferenceKind = "note" | "todo" | "document";
export type InternalReferenceScope = "project" | "workspace";

export interface InternalReferenceContext {
  scope: InternalReferenceScope;
  projectId?: number | null;
}

export interface InternalReferenceSearchInput {
  query: string;
  projectId?: number | null;
  scope: InternalReferenceScope;
  limit: number;
}

export interface InternalReferenceSearchResult {
  kind: InternalReferenceKind;
  id: number;
  label: string;
  scope: InternalReferenceScope;
  projectId: number | null;
  subtitle: string;
  updatedAt: string;
}

export interface InternalReferenceResolveInput {
  kind: InternalReferenceKind;
  id: number;
}

export interface InternalReferenceResolveResult {
  kind: InternalReferenceKind;
  id: number;
  label: string;
  scope: InternalReferenceScope;
  projectId: number | null;
  route: string;
  focusId?: string | null;
  managedPath?: string | null;
}

interface WorkspaceSearchResultBase {
  id: number;
  title: string;
  subtitle: string;
  matchedText: string;
}

export type WorkspaceSearchResult =
  | (WorkspaceSearchResultBase & {
      kind: "workspace_quick_note" | "workspace_note";
      projectId: null;
    })
  | (WorkspaceSearchResultBase & {
      kind: "contact";
      projectId: null;
    })
  | (WorkspaceSearchResultBase & {
      kind: "project" | "note" | "document";
      projectId: number;
    })
  | (WorkspaceSearchResultBase & {
      kind: "todo";
      scope: "workspace";
      projectId: null;
      source: "Workspace";
    })
  | (WorkspaceSearchResultBase & {
      kind: "todo";
      scope: "project";
      projectId: number;
      source: string;
    });

export interface ProjectCreateInput {
  name: string;
  quickNote?: string;
  status?: string;
}

export interface ProjectUpdateInput {
  projectId: number;
  name?: string;
  quickNote: string;
  quickNoteMarkdown?: string;
  quickNoteHtml?: string;
  quickNoteCodeLanguage?: string | null;
  status?: string;
}

export interface ProjectIdInput {
  projectId: number;
}

export interface ProjectsListInput {
  includeArchived?: boolean;
}

export interface WorkspaceSearchInput {
  query: string;
  includeArchived?: boolean;
  projectId?: number | null;
}

export interface ProjectArchiveInput {
  projectId: number;
  isArchived: boolean;
}

export interface ProjectDeleteInput {
  projectId: number;
}

export interface ProjectTagUpsertInput {
  projectId?: number | null;
  id?: number;
  label: string;
  colorKey: TagColorKey;
}

export interface ProjectTagSettingsGetInput {
  projectId?: number | null;
}

export interface ProjectTagDeleteInput {
  projectId?: number | null;
  tagId: number;
}

export interface ContactUpsertInput {
  id?: number;
  name: string;
  pinyinFull?: string;
  pinyinAbbr?: string;
  email?: string;
  employeeId?: string;
  role?: string;
  department?: string;
}

export interface ContactSearchInput {
  query: string;
  limit?: number;
}

export interface ContactDeleteInput {
  contactId: number;
}

export interface ProjectRecordUpsertInput {
  projectId: number;
  noteId?: number;
  title?: string;
  markdown: string;
  html: string;
  defaultCodeLanguage?: string | null;
  tagIds?: number[];
}

export interface ProjectRecordDeleteInput {
  noteId: number;
}

export interface WorkspaceRecordUpsertInput {
  noteId?: number;
  title?: string;
  markdown: string;
  html: string;
  defaultCodeLanguage?: string | null;
  tagIds?: number[];
}

export interface WorkspaceQuickNoteUpsertInput {
  markdown: string;
  html: string;
  defaultCodeLanguage?: string | null;
  tagIds?: number[];
}

export interface WorkspaceRecordDeleteInput {
  noteId: number;
}

interface TodoCreateFields {
  content: string;
  priority: TodoPriority;
  dueDate?: string | null;
  tagIds?: number[];
}

export type TodoCreateInput =
  | (TodoCreateFields & {
      scope: "project";
      projectId: number;
    })
  | (TodoCreateFields & {
      scope: "workspace";
      projectId?: null;
    });

export interface TodoUpdateContentInput {
  todoId: number;
  content: string;
  dueDate?: string | null;
  tagIds?: number[];
}

export interface TodoUpdateTagsInput {
  todoId: number;
  tagIds?: number[];
}

export interface TodoTagUpdatePayload {
  todoId: number;
  tagIds: number[];
  optimisticTags: DocumentTagRecord[];
}

export type TodoTagUpdateHandler = (
  payload: TodoTagUpdatePayload,
) => Promise<unknown> | void;

export interface TodoUpdateStatusInput {
  todoId: number;
  status: TodoStatus;
}

export interface TodoUpdatePriorityInput {
  todoId: number;
  priority: TodoPriority;
}

export interface TodoAddProgressInput {
  todoId: number;
  content: string;
  progressDate: string;
  dueDate?: string | null;
}

export interface TodoUpdateProgressInput {
  progressId: number;
  content: string;
  progressDate: string;
  dueDate?: string | null;
  status?: TodoStatus;
}

export interface TodoDeleteProgressInput {
  progressId: number;
}

export interface TodoDeleteInput {
  todoId: number;
}

export interface DocumentImportInput {
  projectId: number;
  sourcePath: string;
  isStarred: boolean;
  tagIds?: number[];
}

export interface DocumentImportClipboardImageInput {
  projectId: number;
  fileName: string;
  mimeType: string;
  dataBase64: string;
  isStarred: boolean;
  tagIds?: number[];
}

export interface DocumentImportNoteImageInput {
  projectId: number;
  sourcePath: string;
}

export interface DocumentImportClipboardNoteImageInput {
  projectId: number;
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

export interface WorkspaceNoteImageImportInput {
  sourcePath: string;
}

export interface WorkspaceClipboardNoteImageImportInput {
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

export interface WorkspaceNoteImageAsset {
  title: string;
  path: string;
  mimeType: string;
}

export interface DocumentUpdateMetaInput {
  documentId: number;
  baseName?: string;
  isStarred?: boolean;
  tagIds?: number[];
}

export interface DocumentRelocateInput {
  documentId: number;
  newSourcePath: string;
}

export interface DocumentListVersionsInput {
  documentId: number;
}

export interface DocumentAddVersionInput {
  documentId: number;
  sourcePath?: string;
}

export interface DocumentDeleteInput {
  documentId: number;
}

export type AiEditorSkillResultMode = "modify" | "answer" | "auto";

export interface AiEditorSkillRecord {
  id: string;
  name: string;
  icon?: string | null;
  description?: string | null;
  prompt: string;
  resultMode: AiEditorSkillResultMode;
  showInTextMenu: boolean;
  showInImageMenu: boolean;
  profileId?: number | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AiProviderFamily =
  | "openai_compatible"
  | "anthropic_compatible"
  | "gemini_compatible";

export type AiCapability =
  | "default"
  | "image_default";

export interface AiProviderProfileRecord {
  id: number;
  name: string;
  providerFamily: AiProviderFamily;
  baseUrl: string;
  apiKeyLast4: string;
  hasStoredKey: boolean;
  defaultModel: string;
  supportsText: boolean;
  supportsImage: boolean;
  supportsFile: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiCapabilityBindingRecord {
  capability: AiCapability;
  useDefault: boolean;
  profileId?: number | null;
  model?: string | null;
  updatedAt: string;
}

export interface AiSettingsSnapshot {
  profiles: AiProviderProfileRecord[];
  bindings: AiCapabilityBindingRecord[];
  hasUsableDefault: boolean;
  hasUsableImageDefault: boolean;
  securityMode: string;
  aiSecretsUnlocked: boolean;
  execution: AiExecutionSettings;
  editorSkills: AiEditorSkillRecord[];
}

export interface WorkspaceSummary {
  rootPath: string;
  metadataPath: string;
  displayName: string;
  createdAt: string;
}

export interface WorkspaceStatusSnapshot {
  currentWorkspace?: WorkspaceSummary | null;
  recentWorkspaces: WorkspaceSummary[];
  aiSecretsUnlocked: boolean;
  securityMode: string;
}

export interface WorkspaceCreateInput {
  rootPath: string;
  password: string;
}

export interface WorkspaceOpenInput {
  rootPath: string;
}

export interface WorkspaceUnlockInput {
  password: string;
}

export type RichTextFontPreset =
  | "workspace_sans"
  | "work_sans"
  | "noto_sans_sc"
  | "source_serif";

export type RichTextFontSource = "preset" | "system";

export interface RichTextFontSelection {
  source: RichTextFontSource;
  value: string;
}

export interface RichTextStyleBlockSettings {
  fontFamily: RichTextFontSelection;
  fontSizePx: number;
  lineHeight: number;
  paragraphSpacingBeforePx: number;
  paragraphSpacingAfterPx: number;
}

export interface RichTextHeadingStyleSettings {
  fontFamily: RichTextFontSelection;
  lineHeight: number;
  paragraphSpacingBeforePx: number;
  paragraphSpacingAfterPx: number;
  h1SizePx: number;
  h2SizePx: number;
  h3SizePx: number;
}

export interface RichTextStyleSettings {
  body: RichTextStyleBlockSettings;
  headings: RichTextHeadingStyleSettings;
  list: RichTextStyleBlockSettings;
}

export type RichTextStyleUpsertInput = RichTextStyleSettings;

export interface AiProviderProfileUpsertInput {
  id?: number;
  name: string;
  providerFamily: AiProviderFamily;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  supportsText: boolean;
  supportsImage: boolean;
  supportsFile: boolean;
  enabled: boolean;
}

export interface AiProviderProfileDeleteInput {
  profileId: number;
}

export interface AiProfileTestInput {
  id?: number;
  name: string;
  providerFamily: AiProviderFamily;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  supportsText: boolean;
  supportsImage: boolean;
  supportsFile: boolean;
  enabled: boolean;
  testImage?: boolean;
}

export interface AiProfileTestResult {
  success: boolean;
  message: string;
  latencyMs?: number | null;
  resolvedModel?: string | null;
}

export interface AiCapabilityBindingUpsertInput {
  capability: AiCapability;
  useDefault: boolean;
  profileId?: number;
  model?: string;
}

export interface AiEditorSkillUpsertInput {
  id?: string;
  name: string;
  icon?: string | null;
  description?: string | null;
  prompt: string;
  resultMode: AiEditorSkillResultMode;
  showInTextMenu: boolean;
  showInImageMenu: boolean;
  profileId?: number | null;
  sortOrder?: number;
  enabled: boolean;
}

export interface AiEditorImageTarget {
  path: string;
  mimeType: string;
  signature: string;
  annotationState?: string | null;
  beforeMarkdown?: string | null;
  afterMarkdown?: string | null;
}

export interface AiEditorSkillDeleteInput {
  skillId: string;
}

export interface AiEditorSkillReorderInput {
  skillIds: string[];
}
