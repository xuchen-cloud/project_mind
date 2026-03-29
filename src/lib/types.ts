export interface ProjectRecord {
  id: number;
  name: string;
  status: string;
  rootPath: string;
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

export interface NoteRecord {
  id: number;
  projectId: number;
  activityId: number;
  noteType: "quick_note" | "meeting_minutes";
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
  content: string;
  promotedToProject: boolean;
  sourceActivityTitle?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TodoProgressRecord {
  id: number;
  todoId: number;
  content: string;
  statusSnapshot: string;
  createdAt: string;
}

export interface TodoRecord {
  id: number;
  projectId: number;
  activityId?: number | null;
  sourceNoteId?: number | null;
  title: string;
  description?: string | null;
  status: "todo" | "doing" | "done" | "blocked" | "cancelled";
  priority: "low" | "medium" | "high";
  dueDate?: string | null;
  createdAt: string;
  updatedAt: string;
  sourceActivityTitle?: string | null;
  progresses: TodoProgressRecord[];
}

export interface DocumentRecord {
  id: number;
  projectId: number;
  activityId?: number | null;
  name: string;
  originalPath: string;
  managedPath: string;
  storageMode: string;
  mimeType: string;
  role: "key_material" | "reference_material";
  isStarred: boolean;
  promotedToProject: boolean;
  sourceActivityTitle?: string | null;
  health: "normal" | "missing";
  createdAt: string;
  updatedAt: string;
}

export interface ActivityDigest {
  id: number;
  projectId: number;
  category: string;
  title: string;
  activityTime: string;
  reviewStatus: "needs_review" | "organized";
  organizeStatus: "needs_review" | "organized";
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
  category: string;
  title: string;
  activityTime: string;
  isPinned: boolean;
  isExpanded: boolean;
  organizeStatus: "unorganized" | "organized";
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
  keyDocuments: DocumentRecord[];
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
  category: string;
  title?: string;
  activityTime: string;
}

export interface ActivityUpdateMetaInput {
  activityId: number;
  title?: string;
  category?: string;
  activityTime?: string;
  isPinned?: boolean;
  isExpanded?: boolean;
  organizeStatus?: "needs_review" | "organized";
}

export interface NoteAppendQuickInput {
  projectId: number;
  activityId: number;
  title?: string;
  content: string;
}

export interface NoteUpsertMinutesInput {
  projectId: number;
  activityId: number;
  noteId?: number;
  title?: string;
  markdown: string;
  html: string;
}

export interface ConclusionCreateInput {
  projectId: number;
  activityId?: number;
  noteId?: number;
  content: string;
  promotedToProject: boolean;
}

export interface ConclusionListInput {
  projectId: number;
  activityId?: number;
}

export interface ConclusionUpdateInput {
  conclusionId: number;
  content: string;
  promotedToProject?: boolean;
}

export interface TodoCreateInput {
  projectId: number;
  activityId?: number;
  sourceNoteId?: number;
  title: string;
  description?: string;
  status?: TodoRecord["status"];
  priority?: TodoRecord["priority"];
  dueDate?: string;
}

export interface TodoUpdateStatusInput {
  todoId: number;
  status: TodoRecord["status"];
}

export interface TodoAddProgressInput {
  todoId: number;
  content: string;
  statusSnapshot: TodoRecord["status"];
}

export interface DocumentImportInput {
  projectId: number;
  activityId?: number;
  sourcePath: string;
  role: DocumentRecord["role"];
  isStarred: boolean;
  promotedToProject?: boolean;
}

export interface DocumentUpdateMetaInput {
  documentId: number;
  role?: DocumentRecord["role"];
  isStarred?: boolean;
  promotedToProject?: boolean;
}

export interface DocumentRelocateInput {
  documentId: number;
  newSourcePath: string;
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
