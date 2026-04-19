import { create } from "zustand";

import { normalizeRichEditorValue } from "../rich-editor";
import type {
  RichEditorPersistState,
  RichEditorValue,
} from "../rich-editor";
import {
  createDraftNote,
  defaultNoteTemplateKey,
  deriveNoteTitleFromContent,
  getEditableNoteHtml,
  normalizeNoteTitleInput,
  noteTemplateDefaultHtml,
  resolveNoteDisplayTitle,
} from "../../lib/note-templates";
import {
  resolveSuggestedTodoPriority,
} from "../../lib/todo-priority";
import type {
  AiSuggestionRecord,
  NoteRecord,
  NoteTemplateKey,
  NoteUpsertInput,
  RecordTypeSettingsSnapshot,
  TodoPriority,
} from "../../lib/types";

export interface DraftNoteState {
  localId: string;
  noteType: NoteTemplateKey;
  title: string;
  contentMarkdown: string;
  contentHtml: string;
}

export type EditorItem =
  | { kind: "closed" }
  | { kind: "draft" }
  | { kind: "saved"; noteId: number };

export interface ComposerState {
  key: string;
  noteId?: number;
  noteType: NoteTemplateKey;
  title: string;
  contentMarkdown: string;
  contentHtml: string;
}

export interface AiConclusionDraft {
  suggestionId: number;
  checked: boolean;
  content: string;
  promotedToProject: boolean;
}

export interface AiTodoDraft {
  suggestionId: number;
  checked: boolean;
  content: string;
  priority: TodoPriority;
  autoPriority: TodoPriority;
}

export interface AiRefinePreview {
  noteTitle: string;
  conclusions: AiConclusionDraft[];
  todos: AiTodoDraft[];
}

export interface ActivityNoteSessionSnapshot {
  draftNote: DraftNoteState | null;
  editorItem: EditorItem;
  composer: ComposerState | null;
  titleDirty: boolean;
  editorPersistState: RichEditorPersistState;
  aiPreview: AiRefinePreview | null;
  aiJobNoteId: number | null;
  expandedRecordValue: string | null;
  topRecordValue: string | null;
}

export type NoteFocusTarget =
  | { kind: "saved"; noteId: number }
  | { kind: "draft"; localId: string };

interface ActivityNoteSessionStore {
  sessions: Record<number, ActivityNoteSessionSnapshot>;
  setSession: (activityId: number, snapshot: ActivityNoteSessionSnapshot) => void;
  clearSession: (activityId: number) => void;
}

export function createClosedActivityNoteSession(): ActivityNoteSessionSnapshot {
  return {
    draftNote: null,
    editorItem: { kind: "closed" },
    composer: null,
    titleDirty: false,
    editorPersistState: "idle",
    aiPreview: null,
    aiJobNoteId: null,
    expandedRecordValue: null,
    topRecordValue: null,
  };
}

export const useActivityNoteSessionStore = create<ActivityNoteSessionStore>()(
  (set) => ({
    sessions: {},
    setSession: (activityId, snapshot) =>
      set((state) => ({
        sessions: {
          ...state.sessions,
          [activityId]: snapshot,
        },
      })),
    clearSession: (activityId) =>
      set((state) => {
        if (!(activityId in state.sessions)) {
          return state;
        }

        const nextSessions = { ...state.sessions };
        delete nextSessions[activityId];
        return { sessions: nextSessions };
      }),
  }),
);

export function getActivityNoteSession(activityId: number) {
  return useActivityNoteSessionStore.getState().sessions[activityId] ?? null;
}

export function setActivityNoteSession(
  activityId: number,
  snapshot: ActivityNoteSessionSnapshot,
) {
  useActivityNoteSessionStore.getState().setSession(activityId, snapshot);
}

export function clearActivityNoteSession(activityId: number) {
  useActivityNoteSessionStore.getState().clearSession(activityId);
}

export function resetActivityNoteSessions() {
  useActivityNoteSessionStore.setState({ sessions: {} });
}

export function buildComposerFromDraft(
  draft: DraftNoteState,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
): ComposerState {
  return {
    key: `draft:${draft.localId}:${draft.noteType}`,
    noteType: draft.noteType,
    title: normalizeNoteTitleInput(
      draft.title,
      draft.noteType,
      noteTemplateSettings,
    ),
    contentMarkdown: draft.contentMarkdown,
    contentHtml:
      draft.contentHtml ||
      noteTemplateDefaultHtml(draft.noteType, noteTemplateSettings),
  };
}

export function buildComposerFromNote(
  note: NoteRecord,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
): ComposerState {
  return {
    key: `note:${note.id}:${note.updatedAt}:${note.noteType}`,
    noteId: note.id,
    noteType: note.noteType,
    title: normalizeNoteTitleInput(
      note.title,
      note.noteType,
      noteTemplateSettings,
    ),
    contentMarkdown: note.contentMarkdown,
    contentHtml: getEditableNoteHtml(note),
  };
}

export function buildActivityNoteSessionFromNote(
  note: NoteRecord,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
): ActivityNoteSessionSnapshot {
  return {
    ...createClosedActivityNoteSession(),
    editorItem: { kind: "saved", noteId: note.id },
    composer: buildComposerFromNote(note, noteTemplateSettings),
    expandedRecordValue: `note:${note.id}`,
  };
}

export function createActivityNoteSessionSnapshot(input: {
  draftNote: DraftNoteState | null;
  editorItem: EditorItem;
  composer: ComposerState | null;
  titleDirty: boolean;
  editorPersistState: RichEditorPersistState;
  aiPreview: AiRefinePreview | null;
  aiJobNoteId: number | null;
  expandedRecordValue: string | null;
  topRecordValue: string | null;
}) {
  return {
    draftNote: input.draftNote,
    editorItem: input.editorItem,
    composer: input.composer,
    titleDirty: input.titleDirty,
    editorPersistState: input.editorPersistState,
    aiPreview: input.aiPreview,
    aiJobNoteId: input.aiJobNoteId,
    expandedRecordValue: input.expandedRecordValue,
    topRecordValue: input.topRecordValue,
  } satisfies ActivityNoteSessionSnapshot;
}

export function isInactiveActivityNoteSession(
  snapshot: ActivityNoteSessionSnapshot,
) {
  return (
    snapshot.editorItem.kind === "closed" &&
    snapshot.draftNote === null &&
    snapshot.composer === null &&
    snapshot.aiPreview === null &&
    snapshot.aiJobNoteId === null &&
    snapshot.expandedRecordValue === null &&
    snapshot.topRecordValue === null
  );
}

export function buildNoteFocusTarget(input: {
  editorItem: EditorItem;
  draftNote: DraftNoteState | null;
}) {
  if (input.editorItem.kind === "saved") {
    return { kind: "saved", noteId: input.editorItem.noteId } satisfies NoteFocusTarget;
  }

  if (input.editorItem.kind === "draft" && input.draftNote) {
    return { kind: "draft", localId: input.draftNote.localId } satisfies NoteFocusTarget;
  }

  return null;
}

export function sessionMatchesNoteFocusTarget(
  snapshot: ActivityNoteSessionSnapshot | null,
  target: NoteFocusTarget,
) {
  if (!snapshot) {
    return false;
  }

  if (target.kind === "saved") {
    return (
      snapshot.editorItem.kind === "saved" &&
      snapshot.editorItem.noteId === target.noteId
    );
  }

  return (
    snapshot.editorItem.kind === "draft" &&
    snapshot.draftNote?.localId === target.localId
  );
}

export function isSavedNoteRecord(value: unknown): value is NoteRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "activityId" in value &&
    "contentMarkdown" in value
  );
}

export function buildConclusionSuggestionDraft(
  suggestion: AiSuggestionRecord,
): AiConclusionDraft {
  return {
    suggestionId: suggestion.id,
    checked: true,
    content:
      readSuggestionPayloadString(suggestion.payload, "content") ??
      suggestion.preview,
    promotedToProject:
      readSuggestionPayloadBoolean(suggestion.payload, "promotedToProject") ??
      true,
  };
}

export function buildTodoSuggestionDraft(
  suggestion: AiSuggestionRecord,
): AiTodoDraft {
  const content =
    readSuggestionPayloadString(suggestion.payload, "content") ??
    suggestion.preview;
  const autoPriority = resolveSuggestedTodoPriority(
    content,
    readSuggestionPayloadString(suggestion.payload, "priority"),
  );

  return {
    suggestionId: suggestion.id,
    checked: true,
    content,
    priority: autoPriority,
    autoPriority,
  };
}

export function readSuggestedNoteTitle(
  suggestions: AiSuggestionRecord[],
  noteId: number,
) {
  const titleSuggestion = suggestions.find(
    (suggestion) =>
      suggestion.noteId === noteId &&
      suggestion.suggestionType === "activity_title",
  );

  return titleSuggestion
    ? (readSuggestionPayloadString(titleSuggestion.payload, "proposedTitle") ??
        titleSuggestion.preview)
    : null;
}

export function persistComposerNote({
  editorItem,
  activeNote,
  activityId,
  composer,
  draftNote,
  noteTemplateSettings,
  onUpsertNote,
  projectId,
  resolvedTitle,
  setEditorItem,
  setComposer,
  setDraftNote,
  value,
}: {
  editorItem: EditorItem;
  activeNote: NoteRecord | null;
  activityId: number;
  composer: ComposerState;
  draftNote: DraftNoteState | null;
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null;
  onUpsertNote: (input: NoteUpsertInput) => Promise<NoteRecord>;
  projectId: number;
  resolvedTitle: string;
  setEditorItem: (value: EditorItem) => void;
  setComposer: (value: ComposerState | null) => void;
  setDraftNote: (value: DraftNoteState | null) => void;
  value: RichEditorValue;
}) {
  const normalizedValue = normalizeRichEditorValue(value);

  if (editorItem.kind === "draft") {
    const currentDraft =
      draftNote ?? createDraftNote(composer.noteType, noteTemplateSettings);
    const nextDraft = {
      ...currentDraft,
      noteType: composer.noteType,
      title: resolvedTitle,
      contentMarkdown: normalizedValue.markdown,
      contentHtml: normalizedValue.html,
    };

    setDraftNote(nextDraft);

    if (isDraftPristine(nextDraft, composer.noteType, noteTemplateSettings)) {
      return Promise.resolve(undefined);
    }

    return onUpsertNote({
      projectId,
      activityId,
      noteType: composer.noteType,
      title: resolvedTitle,
      markdown: normalizedValue.markdown,
      html: normalizedValue.html,
    }).then((createdNote) => {
      setDraftNote(null);
      setEditorItem({ kind: "saved", noteId: createdNote.id });
      setComposer(buildComposerFromNote(createdNote, noteTemplateSettings));
      return createdNote;
    });
  }

  if (!activeNote) {
    return Promise.resolve(undefined);
  }

  return onUpsertNote({
    projectId,
    activityId,
    noteId: activeNote.id,
    noteType: composer.noteType,
    title: resolvedTitle,
    markdown: normalizedValue.markdown,
    html: normalizedValue.html,
  }).then((updatedNote) => {
    setComposer(buildComposerFromNote(updatedNote, noteTemplateSettings));
    return updatedNote;
  });
}

export function isDraftPristine(
  draft: Pick<DraftNoteState, "title" | "contentHtml" | "contentMarkdown">,
  template: NoteTemplateKey,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
) {
  return (
    normalizeNoteTitleInput(draft.title, template, noteTemplateSettings)
      .length === 0 &&
    normalizeEditorHtml(draft.contentHtml, noteTemplateSettings) ===
      normalizeEditorHtml(
        noteTemplateDefaultHtml(template, noteTemplateSettings),
        noteTemplateSettings,
      ) &&
    draft.contentMarkdown.trim().length === 0
  );
}

export function createFreshDraftSession(
  template: NoteTemplateKey,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
) {
  const draft = createDraftNote(template, noteTemplateSettings);

  return createActivityNoteSessionSnapshot({
    ...createClosedActivityNoteSession(),
    draftNote: draft,
    editorItem: { kind: "draft" },
    composer: buildComposerFromDraft(draft, noteTemplateSettings),
    expandedRecordValue: `draft:${draft.localId}`,
  });
}

export function resolveSuggestedTitleForComposer(input: {
  composer: ComposerState;
  recordTypeSettings?: RecordTypeSettingsSnapshot | null;
}) {
  const explicitTitle = input.composer.title.trim();
  const fallbackTitle = deriveNoteTitleFromContent(
    {
      contentMarkdown: input.composer.contentMarkdown,
      contentHtml: input.composer.contentHtml,
    },
    input.composer.noteType,
    input.recordTypeSettings,
  );

  return explicitTitle || fallbackTitle;
}

export function resolveNoteFocusTitle(input: {
  composer: ComposerState | null;
  activeNote: NoteRecord | null;
  draftNote: DraftNoteState | null;
  recordTypeSettings?: RecordTypeSettingsSnapshot | null;
}) {
  if (input.composer) {
    return resolveNoteDisplayTitle(
      {
        title: input.composer.title,
        contentMarkdown: input.composer.contentMarkdown,
        contentHtml: input.composer.contentHtml,
      },
      input.composer.noteType,
      input.recordTypeSettings,
    );
  }

  if (input.activeNote) {
    return resolveNoteDisplayTitle(
      input.activeNote,
      input.activeNote.noteType,
      input.recordTypeSettings,
    );
  }

  if (input.draftNote) {
    return resolveNoteDisplayTitle(
      {
        title: input.draftNote.title,
        contentMarkdown: input.draftNote.contentMarkdown,
        contentHtml: input.draftNote.contentHtml,
      },
      input.draftNote.noteType,
      input.recordTypeSettings,
    );
  }

  return "";
}

function readSuggestionPayloadString(
  payload: Record<string, unknown>,
  key: string,
) {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readSuggestionPayloadBoolean(
  payload: Record<string, unknown>,
  key: string,
) {
  const value = payload[key];
  return typeof value === "boolean" ? value : null;
}

function normalizeEditorHtml(
  html: string,
  noteTemplateSettings?: RecordTypeSettingsSnapshot | null,
) {
  const normalized = html.trim();
  return normalized.length > 0
    ? normalized
    : noteTemplateDefaultHtml(
        defaultNoteTemplateKey(noteTemplateSettings),
        noteTemplateSettings,
      );
}
