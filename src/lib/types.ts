export interface ProjectRecord {
  id: number;
  name: string;
  kind: "normal" | "reference";
  status: string;
  rootPath: string;
  summary: string;
  summaryMarkdown?: string;
  summaryHtml?: string;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem extends ProjectRecord {
  activityCount: number;
  unorganizedCount: number;
  openTodoCount: number;
}

export type RecordTypeKey = string;
export type NoteTemplateKey = RecordTypeKey;

export interface NoteRecord {
  id: number;
  projectId: number;
  noteType: NoteTemplateKey;
  title?: string | null;
  contentMarkdown: string;
  contentHtml: string;
  tags?: DocumentTagRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ConclusionRecord {
  id: number;
  projectId: number;
  noteId?: number | null;
  contentMarkdown: string;
  contentHtml: string;
  promotedToProject: boolean;
  isPinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TodoStatus = "unfinished" | "finished";
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
  status?: TodoStatus;
  completedAt?: string | null;
  orderIndex?: number;
  createdAt: string;
}

export interface TodoRecord {
  id: number;
  projectId: number;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  tags?: DocumentTagRecord[];
  createdAt: string;
  updatedAt: string;
  progresses: TodoProgressRecord[];
}

export interface WorkspaceNoteRecord {
  id: number;
  title?: string | null;
  contentMarkdown: string;
  contentHtml: string;
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

export type FileTagColorKey =
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
  colorKey: FileTagColorKey;
}

export interface FileTagRecord {
  id: number;
  label: string;
  colorKey: FileTagColorKey;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityAttributeOption {
  id: number;
  label: string;
  colorKey: FileTagColorKey;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityStatusOption {
  id: number;
  label: string;
  colorKey: FileTagColorKey;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ActivitySettingsSnapshot {
  activityAttributeOptions: ActivityAttributeOption[];
  activityStatusOptions: ActivityStatusOption[];
}

export interface FileTagSettingsSnapshot {
  tags: FileTagRecord[];
}

export interface ProjectRecordGroup {
  groupKey: string;
  groupTitle: string;
  notes: NoteRecord[];
}

export interface RecordTypeRecord {
  id: number;
  key: RecordTypeKey;
  label: string;
  colorKey: FileTagColorKey;
  templateHtml: string;
  isDefault: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecordTypeSettingsSnapshot {
  recordTypes: RecordTypeRecord[];
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

export interface ActivityDigest {
  id: number;
  projectId: number;
  attributeOptionId?: number | null;
  attributeLabel?: string | null;
  attributeColorKey?: FileTagColorKey | null;
  title: string;
  activityTime: string;
  statusOptionId: number;
  statusLabel: string;
  statusColorKey: FileTagColorKey;
  isPinned: boolean;
  noteCount: number;
  conclusionCount: number;
  todoCount: number;
  documentCount: number;
  completedTodoCount: number;
  totalTodoCount: number;
  hasOpenTodos: boolean;
}

export interface AiSuggestionRecord {
  id: number;
  projectId: number;
  noteId?: number | null;
  suggestionType: "conclusion" | "todo";
  title: string;
  preview: string;
  payload: Record<string, unknown>;
  status: "pending" | "accepted";
  createdAt: string;
  acceptedAt?: string | null;
}

export type AiArtifactKind = "project_brief" | "daily_brief";

export interface AiArtifactSection {
  title: string;
  items: string[];
}

export interface AiArtifactPayload {
  overview: string;
  sections: AiArtifactSection[];
}

export interface AiArtifactCitationRecord {
  id: number;
  artifactId: number;
  sourceKind:
    | "project"
    | "note"
    | "conclusion"
    | "todo"
    | "document";
  sourceId: number;
  projectId?: number | null;
  label: string;
  excerpt: string;
  orderIndex: number;
}

export interface AiArtifactRecord {
  id: number;
  kind: AiArtifactKind;
  skillKey: string;
  skillVersion: string;
  projectId?: number | null;
  artifactDate?: string | null;
  status: "fresh" | "stale" | "error";
  markdown: string;
  jsonPayload: AiArtifactPayload;
  sourceUpdatedAt: string;
  generatedAt?: string | null;
  errorMessage?: string | null;
  citations: AiArtifactCitationRecord[];
  createdAt: string;
  updatedAt: string;
}

export type AiAnswerScope = "workspace" | "project";

export interface AiAnswerQuestionInput {
  scope: AiAnswerScope;
  question: string;
  projectId?: number;
}

export type AiJobKind =
  | "artifact_refresh"
  | "answer_question"
  | "note_suggestions"
  | "profile_test"
  | "editor_rewrite";

export type AiJobStatus = "queued" | "running" | "succeeded" | "failed";

export interface AiExecutionSettings {
  maxConcurrency: 1 | 2 | 3 | 4;
}

export interface AiJobBase {
  kind: AiJobKind;
}

export interface AiArtifactRefreshJobResult extends AiJobBase {
  kind: "artifact_refresh";
  artifact: AiArtifactRecord;
}

export interface AiAnswerQuestionJobResult extends AiJobBase {
  kind: "answer_question";
  answer: AiAnswerResult;
}

export interface AiNoteSuggestionsJobResult extends AiJobBase {
  kind: "note_suggestions";
  suggestions: AiSuggestionRecord[];
}

export interface AiProfileTestJobResult extends AiJobBase {
  kind: "profile_test";
  testResult: AiProfileTestResult;
}

export interface AiEditorRewriteResult {
  actionId?: number | null;
  rewrittenMarkdown: string;
  resolvedModel?: string | null;
}

export interface AiEditorRewriteJobResult extends AiJobBase {
  kind: "editor_rewrite";
  rewrite: AiEditorRewriteResult;
}

export type AiJobResult =
  | AiArtifactRefreshJobResult
  | AiAnswerQuestionJobResult
  | AiNoteSuggestionsJobResult
  | AiProfileTestJobResult
  | AiEditorRewriteJobResult;

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

export interface AiArtifactRefreshJobInput {
  kind: "artifact_refresh";
  targetKey: string;
  input: AiArtifactGetInput;
}

export interface AiAnswerQuestionJobInput {
  kind: "answer_question";
  targetKey: string;
  input: AiAnswerQuestionInput;
}

export interface AiNoteSuggestionsJobInput {
  kind: "note_suggestions";
  targetKey: string;
  input: AiGenerateInput;
}

export interface AiProfileTestJobInput {
  kind: "profile_test";
  targetKey: string;
  input: AiProfileTestInput;
}

export type AiEditorRewriteScope = "activity_note" | "workspace_note";

export interface AiEditorRewriteContext {
  scope: AiEditorRewriteScope;
  projectId?: number | null;
  activityId?: number | null;
  noteId?: number | null;
  workspaceNoteId?: number | null;
  sourceLabel?: string | null;
}

export interface AiEditorRewriteInput {
  actionId?: number | null;
  promptOverride?: string | null;
  selectedText: string;
  expandedMarkdown: string;
  placeholderTokens: string[];
  context?: AiEditorRewriteContext;
}

export interface AiEditorRewriteJobInput {
  kind: "editor_rewrite";
  targetKey: string;
  input: AiEditorRewriteInput;
}

export type AiJobEnqueueInput =
  | AiArtifactRefreshJobInput
  | AiAnswerQuestionJobInput
  | AiNoteSuggestionsJobInput
  | AiProfileTestJobInput
  | AiEditorRewriteJobInput;

export interface AiAnswerCitationRecord {
  refCode: string;
  sourceKind:
    | "project"
    | "note"
    | "conclusion"
    | "todo"
    | "document";
  sourceId: number;
  projectId?: number | null;
  label: string;
  excerpt: string;
}

export interface AiAnswerResult {
  answerMarkdown: string;
  citations: AiAnswerCitationRecord[];
  scope: AiAnswerScope;
  generatedAt: string;
  skillKey: string;
  skillVersion: string;
}

export interface ActivityCardData {
  id: number;
  projectId: number;
  attributeOptionId?: number | null;
  attributeLabel?: string | null;
  attributeColorKey?: FileTagColorKey | null;
  title: string;
  briefMarkdown?: string;
  briefHtml?: string;
  activityTime: string;
  statusOptionId: number;
  statusLabel: string;
  statusColorKey: FileTagColorKey;
  isPinned: boolean;
  isExpanded: boolean;
  createdAt: string;
  updatedAt: string;
  digest: ActivityDigest;
  notes: NoteRecord[];
  conclusions: ConclusionRecord[];
  todos: TodoRecord[];
  documents: DocumentRecord[];
  aiSuggestions: AiSuggestionRecord[];
}

export interface ProjectDashboard {
  project: ProjectRecord;
  keyConclusions: ConclusionRecord[];
  openTodos: TodoRecord[];
  starredDocuments: DocumentRecord[];
  recentActivities: ActivityDigest[];
  unorganizedCount: number;
}

export interface ConclusionGroup {
  activityId?: number | null;
  activityTitle: string;
  conclusions: ConclusionRecord[];
}

export interface ProjectOverviewData {
  project: ProjectRecord;
  activityFeed: ActivityDigest[];
  projectDocuments: DocumentRecord[];
  conclusionGroups: ConclusionGroup[];
  recordGroups?: ProjectRecordGroup[];
  records?: NoteRecord[];
  unfinishedTodos: TodoRecord[];
  finishedTodos: TodoRecord[];
}

export type InternalReferenceKind = "note" | "conclusion" | "todo" | "document";
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
  projectId: number;
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
  projectId: number;
  route: string;
  focusId?: string | null;
}

export interface WorkspaceSearchResult {
  kind: "project" | "note" | "conclusion" | "todo" | "document";
  id: number;
  projectId: number;
  title: string;
  subtitle: string;
  matchedText: string;
}

export interface ProjectCreateInput {
  name: string;
  summary?: string;
  status?: string;
}

export interface ProjectUpdateSummaryInput {
  projectId: number;
  name?: string;
  summary: string;
  summaryMarkdown?: string;
  summaryHtml?: string;
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
}

export interface ProjectArchiveInput {
  projectId: number;
  isArchived: boolean;
}

export interface ActivityCreateInput {
  projectId: number;
  attributeOptionId?: number | null;
  title?: string;
  activityTime: string;
}

export interface ActivityUpdateMetaInput {
  activityId: number;
  title?: string;
  briefMarkdown?: string;
  briefHtml?: string;
  attributeOptionId?: number | null;
  clearAttributeOption?: boolean;
  activityTime?: string;
  isPinned?: boolean;
  isExpanded?: boolean;
  statusOptionId?: number;
}

export interface ActivityDeleteInput {
  activityId: number;
}

export interface ActivityAttributeOptionUpsertInput {
  id?: number;
  label: string;
  colorKey: FileTagColorKey;
}

export interface ActivityStatusOptionUpsertInput {
  id?: number;
  label: string;
  colorKey: FileTagColorKey;
}

export interface ActivityOptionDeleteInput {
  optionId: number;
}

export interface FileTagOptionUpsertInput {
  projectId?: number;
  id?: number;
  label: string;
  colorKey: FileTagColorKey;
}

export interface FileTagOptionDeleteInput {
  tagId: number;
}

export interface RecordTypeOptionUpsertInput {
  id?: number;
  label: string;
  colorKey: FileTagColorKey;
  templateHtml: string;
  isDefault: boolean;
}

export interface RecordTypeOptionDeleteInput {
  typeId: number;
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

export interface NoteUpsertInput {
  projectId: number;
  noteId?: number;
  noteType: NoteTemplateKey;
  title?: string;
  markdown: string;
  html: string;
  tagIds?: number[];
}

export interface NoteDeleteInput {
  noteId: number;
}

export interface WorkspaceNoteUpsertInput {
  noteId?: number;
  title?: string;
  markdown: string;
  html: string;
}

export interface TodayQuickNoteUpsertInput {
  markdown: string;
  html: string;
}

export interface WorkspaceNoteDeleteInput {
  noteId: number;
}

export interface ConclusionCreateInput {
  projectId: number;
  noteId?: number;
  markdown: string;
  html: string;
  promotedToProject: boolean;
  isPinned?: boolean;
}

export interface ConclusionListInput {
  projectId: number;
}

export interface ConclusionUpdateInput {
  conclusionId: number;
  markdown: string;
  html: string;
  promotedToProject?: boolean;
  isPinned?: boolean;
}

export interface ConclusionDeleteInput {
  conclusionId: number;
}

export interface TodoCreateInput {
  projectId: number;
  content: string;
  priority: TodoPriority;
  tagIds?: number[];
}

export interface TodoUpdateContentInput {
  todoId: number;
  content: string;
  tagIds?: number[];
}

export interface TodoUpdateTagsInput {
  todoId: number;
  tagIds?: number[];
}

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
}

export interface TodoUpdateProgressInput {
  progressId: number;
  content: string;
  progressDate: string;
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

export interface AiGenerateInput {
  projectId: number;
  activityId: number;
  noteId?: number;
}

export interface AiAcceptSuggestionInput {
  suggestionId: number;
  payloadOverride?: Record<string, unknown>;
}

export interface AiArtifactGetInput {
  kind: AiArtifactKind;
  projectId?: number;
  artifactDate?: string;
}

export interface AcceptedSuggestionResult {
  suggestion: AiSuggestionRecord;
  entityKind: string;
  entityId: number;
}

export interface AiEditorRewriteActionRecord {
  id: number;
  label: string;
  prompt: string;
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
  | "assistant"
  | "summary"
  | "suggestion_generation"
  | "editor_rewrite";

export type AiManagedCapability = Exclude<AiCapability, "default">;

export type AiFeatureKey =
  | "summary.project_brief"
  | "summary.daily_brief"
  | "suggestion_generation.conclusion"
  | "suggestion_generation.todo";

export type AiSuggestionFeatureType = "conclusion" | "todo";

export interface AiFeatureSettings {
  masterEnabled: boolean;
  capabilities: Record<AiManagedCapability, boolean>;
  features: Record<AiFeatureKey, boolean>;
}

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
  securityMode: string;
  aiSecretsUnlocked: boolean;
  execution: AiExecutionSettings;
  featureSettings: AiFeatureSettings;
  editorRewriteActions: AiEditorRewriteActionRecord[];
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

export type AiFeatureSettingsUpsertInput = AiFeatureSettings;

export interface AiEditorRewriteActionUpsertInput {
  id?: number;
  label: string;
  prompt: string;
  enabled: boolean;
}

export interface AiEditorRewriteActionDeleteInput {
  actionId: number;
}
