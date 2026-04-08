export interface ProjectRecord {
  id: number;
  name: string;
  status: string;
  rootPath: string;
  fileLayoutVersion: number;
  summary: string;
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
  activityId: number;
  noteType: NoteTemplateKey;
  title?: string | null;
  contentMarkdown: string;
  contentHtml: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConclusionRecord {
  id: number;
  projectId: number;
  activityId?: number | null;
  noteId?: number | null;
  contentMarkdown: string;
  contentHtml: string;
  promotedToProject: boolean;
  sourceActivityTitle?: string | null;
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
  createdAt: string;
}

export interface TodoRecord {
  id: number;
  projectId: number;
  activityId?: number | null;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
  createdAt: string;
  updatedAt: string;
  progresses: TodoProgressRecord[];
}

export interface DocumentRecord {
  id: number;
  projectId: number;
  activityId?: number | null;
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
  sourceActivityTitle?: string | null;
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
  activityId?: number | null;
  noteId?: number | null;
  suggestionType: "activity_title" | "conclusion" | "todo";
  title: string;
  preview: string;
  payload: Record<string, unknown>;
  status: "pending" | "accepted";
  createdAt: string;
  acceptedAt?: string | null;
}

export interface ActivityCardData {
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
  unfinishedTodos: TodoRecord[];
  finishedTodos: TodoRecord[];
}

export interface WorkspaceSearchResult {
  kind: "project" | "activity" | "conclusion" | "todo" | "document";
  id: number;
  projectId: number;
  activityId?: number | null;
  title: string;
  subtitle: string;
  matchedText: string;
}

export interface ProjectCreateInput {
  name: string;
  summary?: string;
  status?: string;
  workspaceRoot: string;
}

export interface ProjectUpdateSummaryInput {
  projectId: number;
  name?: string;
  summary: string;
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
  attributeOptionId?: number | null;
  clearAttributeOption?: boolean;
  activityTime?: string;
  isPinned?: boolean;
  isExpanded?: boolean;
  statusOptionId?: number;
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

export interface NoteUpsertInput {
  projectId: number;
  activityId: number;
  noteId?: number;
  noteType: NoteTemplateKey;
  title?: string;
  markdown: string;
  html: string;
}

export interface ConclusionCreateInput {
  projectId: number;
  activityId?: number;
  noteId?: number;
  markdown: string;
  html: string;
  promotedToProject: boolean;
}

export interface ConclusionListInput {
  projectId: number;
  activityId?: number;
}

export interface ConclusionUpdateInput {
  conclusionId: number;
  markdown: string;
  html: string;
  promotedToProject?: boolean;
}

export interface TodoCreateInput {
  projectId: number;
  activityId?: number;
  content: string;
  priority: TodoPriority;
}

export interface TodoUpdateContentInput {
  todoId: number;
  content: string;
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

export interface DocumentImportInput {
  projectId: number;
  activityId?: number;
  sourcePath: string;
  isStarred: boolean;
  tagIds?: number[];
}

export interface DocumentUpdateMetaInput {
  documentId: number;
  activityId?: number | null;
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
  sourcePath: string;
}

export interface AiGenerateInput {
  projectId: number;
  activityId: number;
  noteId?: number;
}

export interface AiAcceptSuggestionInput {
  suggestionId: number;
}

export interface AcceptedSuggestionResult {
  suggestion: AiSuggestionRecord;
  entityKind: string;
  entityId: number;
}

export type AiProviderFamily =
  | "openai_compatible"
  | "anthropic_compatible"
  | "gemini_compatible";

export type AiCapability =
  | "default"
  | "assistant"
  | "summary"
  | "suggestion_generation";

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
}

export type RichTextFontPreset =
  | "workspace_sans"
  | "work_sans"
  | "noto_sans_sc"
  | "source_serif";

export interface RichTextStyleBlockSettings {
  fontPreset: RichTextFontPreset;
  fontSizePx: number;
  lineHeight: number;
  paragraphSpacingBeforePx: number;
  paragraphSpacingAfterPx: number;
}

export interface RichTextHeadingStyleSettings {
  fontPreset: RichTextFontPreset;
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
