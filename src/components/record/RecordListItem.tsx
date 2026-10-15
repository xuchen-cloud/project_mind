import { VoiceRecordIcon } from "../icons/ContentTypeIcon";
import { HomeRecordPreview } from "../home/HomeRecordPreview";
import { cancelQuickNoteRecordMetadata } from "../../lib/quick-note-auto-metadata";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp, ExternalLink, Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCanonicalRecordEditor } from "../../hooks/useCanonicalRecordEditor";
import { useRecordClipboard } from "../../hooks/useRecordClipboard";
import { createRecordSaveCoordinator, useRecordSaveCoordinator } from "../../lib/record-save-runtime";
import { projectRecordSaveKey, workspaceRecordSaveKey } from "../../lib/record-save-coordinator";
import { queryKeys } from "../../lib/queryKeys";
import type { WorkspaceStatusSnapshot } from "../../lib/types";
import { RecordConflictActions } from "./RecordConflictActions";

import { formatDateTime } from "../../lib/formatters";
import { colorKeyForTagLabel } from "../../lib/tags";
import { projectMindApi } from "../../services/projectMindApi";
import { Button, IconButton, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import { commitListLayoutChange } from "../../ui/listLayoutMotion";
import { useMotionPresence } from "../../hooks/useMotionPresence";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import {
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  RichTextViewer,
  type RichEditorAssetHandlers,
  type RichEditorAutoFocusPoint,
  type RichEditorContactMentionOptions,
  type RichEditorController,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";
import type {
  AiSettingsSnapshot,
  DocumentTagRecord,
  ProjectTagRecord,
  InternalReferenceContext,
} from "../../lib/types";
import type { InternalReferenceTarget } from "../../lib/internalReferences";

const RECORD_COLLAPSED_CONTENT_HEIGHT = 320;
const COLLAPSE_OVERFLOW_TOLERANCE = 2;
const BROWSE_DOUBLE_CLICK_WINDOW_MS = 650;
const EMPTY_RECORD_DRAFT: RichEditorValue = { html: "", text: "", markdown: "" };

export interface RecordListItemRecord {
  id: number;
  title?: string | null;
  isVoice?: boolean;
  contentMarkdown: string;
  contentHtml: string;
  defaultCodeLanguage?: string | null;
  tags?: DocumentTagRecord[];
  createdAt: string;
  updatedAt: string;
}

export type RecordListItemScope =
  | {
      kind: "workspace";
      assetHandlers?: RichEditorAssetHandlers;
    }
  | {
      kind: "project";
      projectId: number;
      assetHandlers: RichEditorAssetHandlers;
    };

interface RecordListItemProps<TRecord extends RecordListItemRecord> {
  homepage?: boolean;
  record: TRecord;
  scope: RecordListItemScope;
  focused: boolean;
  availableTags: ProjectTagRecord[];
  busy: boolean;
  active: boolean;
  aiSettings: AiSettingsSnapshot | null;
  contactMentionOptions: RichEditorContactMentionOptions;
  scrollParentSelector: string;
  onOpenFocusPage: (record: TRecord) => Promise<void> | void;
  onOpenContextMenu: (event: ReactMouseEvent, recordId: number) => void;
  onOpenInternalReference: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onCreatedTag?: (tag: ProjectTagRecord) => void;
  onOpenAiSettings: () => void;
}

export function RecordListItem<TRecord extends RecordListItemRecord>({
  record,
  homepage = false,
  scope,
  focused,
  availableTags,
  busy,
  active,
  aiSettings,
  contactMentionOptions,
  scrollParentSelector,
  onOpenFocusPage,
  onOpenContextMenu,
  onOpenInternalReference,
  onCreatedTag,
  onOpenAiSettings,
}: RecordListItemProps<TRecord>) {
  const [editing, setEditing] = useState(false);
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [autoFocusEditor, setAutoFocusEditor] = useState(true);
  const [autoFocusPoint, setAutoFocusPoint] = useState<RichEditorAutoFocusPoint | null>(null);
  const [title, setTitle] = useState(record.title ?? "");
  const [value, setValue] = useState<RichEditorValue>(EMPTY_RECORD_DRAFT);
  const [tagIds, setTagIds] = useState<number[]>((record.tags ?? []).map((tag) => tag.id));
  const [codeLanguage, setCodeLanguage] = useState<string | null>(
    record.defaultCodeLanguage ?? null,
  );
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const containerRef = useRef<HTMLElement | null>(null);
  const editorControllerRef = useRef<RichEditorController | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const exitScrollTopRef = useRef<number | null>(null);
  const pendingAnchorTopRef = useRef<number | null>(null);
  const browseEditStartedAtRef = useRef<number | null>(null);
  const focusPageOpeningRef = useRef(false);
  const saveSignatureRef = useRef("");
  const submittedSignatureRef = useRef("");
  const resolvingConflictRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = useRef({ title, tagIds, codeLanguage });
  latest.current = { title, tagIds, codeLanguage };
  const queryClient = useQueryClient();
  const sharedCoordinator = useRecordSaveCoordinator();
  const workspaceRoot = sharedCoordinator?.workspaceKey ?? queryClient.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath ?? "";
  const fallbackCoordinator = useMemo(() => createRecordSaveCoordinator({ workspaceKey: workspaceRoot, queryClient }), [workspaceRoot, queryClient]);
  const coordinator = sharedCoordinator ?? fallbackCoordinator;
  const recordSaveKey = scope.kind === "project" ? projectRecordSaveKey(scope.projectId, record.id) : workspaceRecordSaveKey(record.id);
  const canonical = useCanonicalRecordEditor({
    target: { recordId: record.id, scope: scope.kind === "project" ? { kind: "project", projectId: scope.projectId } : { kind: "workspace" } },
    coordinator, enabled: editing,
    flushEditor: async () => {
      const editor = editorControllerRef.current;
      if (!editor) return "busy";
      if (editor.getPendingAiReviewCount() > 0) return "review_pending";
      const before = JSON.stringify([latest.current, editor.getCommittedDocumentJson()]);
      await persistRecord(editor.getCommittedValue(), latest.current.title, latest.current.tagIds);
      return editor.getPendingAiReviewCount() > 0 ? "review_pending" : before === JSON.stringify([latest.current, editor.getCommittedDocumentJson()]) ? "saved" : "busy";
    },
    receiveIncoming: (state, previous) => {
      const editor = editorControllerRef.current;
      if (!editor || latest.current.title !== (previous.metadata.title ?? "")
        || JSON.stringify([...latest.current.tagIds].sort((a, b) => a - b)) !== JSON.stringify([...previous.metadata.tagIds].sort((a, b) => a - b))
        || latest.current.codeLanguage !== previous.codeLanguage || !editor.applyIncomingContent(state.record.contentHtml)) return false;
      setTitle(state.metadata.title ?? ""); setTagIds(state.metadata.tagIds); setCodeLanguage(state.head.projection.codeLanguage);
      const committed = editor.getCommittedValue(); setValue(committed);
      saveSignatureRef.current = buildRecordSaveSignature(committed, state.metadata.title ?? "", state.metadata.tagIds, state.head.projection.codeLanguage);
      submittedSignatureRef.current = saveSignatureRef.current;
      return true;
    },
  });
  const recordClipboard = useRecordClipboard(canonical.binding, canonical.state?.head.target ?? null);
  const [hydratedIdentity, setHydratedIdentity] = useState<string | null>(null);
  const editingReady = canonical.ready && canonical.loadIdentity === hydratedIdentity;
  const mounted = useRef(false);
  const editContext = { active, editing, key: recordSaveKey, loadIdentity: canonical.loadIdentity };
  const editContextRef = useRef(editContext);
  const previousContext = editContextRef.current;
  if (previousContext.active !== active || previousContext.editing !== editing
    || previousContext.key !== recordSaveKey || previousContext.loadIdentity !== canonical.loadIdentity) editContextRef.current = editContext;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function isCurrentEdit(context: typeof editContext) { return mounted.current && editContextRef.current === context; }
  useLayoutEffect(() => {
    if (!canonical.state || !canonical.loadIdentity || canonical.loadIdentity === hydratedIdentity) return;
    const pending = coordinator.getLatestSnapshot(recordSaveKey);
    const current = canonical.state;
    const content = pending?.committedContent ?? buildRecordDraft(current.record);
    const nextTitle = pending?.title ?? current.metadata.title ?? "";
    const nextTags = pending?.tagIds ?? current.metadata.tagIds;
    const language = pending ? pending.defaultCodeLanguage : current.head.projection.codeLanguage;
    setValue(content); setTitle(nextTitle); setTagIds([...nextTags]); setCodeLanguage(language);
    saveSignatureRef.current = pending ? "" : buildRecordSaveSignature(content, nextTitle, nextTags, language);
    submittedSignatureRef.current = pending ? buildRecordSaveSignature(content, nextTitle, nextTags, language) : saveSignatureRef.current;
    resolvingConflictRef.current = false; setSaveError(null); setHydratedIdentity(canonical.loadIdentity);
  }, [canonical.state, canonical.loadIdentity, coordinator, recordSaveKey, hydratedIdentity]);
  const recordTags = record.tags ?? [];
  const recordTagIds = recordTags.map((tag) => tag.id);
  const selectedTags = availableTags.filter((tag) => tagIds.includes(tag.id));
  const recordSnapshotKey = `${record.id}:${record.updatedAt}:${record.title ?? ""}:${recordTagIds.join(",")}`;
  const titleDisplay = record.title?.trim() || "未命名记录";
  const shouldShowHeaderAddTag = editing && tagIds.length === 0 && !showTagEditor;
  const shouldShowEditingTagRow = selectedTags.length > 0 || showTagEditor;
  const projectId = scope.kind === "project" ? scope.projectId : null;
  const internalReferenceContext = useMemo<InternalReferenceContext>(
    () =>
      scope.kind === "project"
        ? { scope: "project", projectId: scope.projectId }
        : { scope: "workspace" },
    [scope],
  );

  useEffect(() => {
    if (!editing) {
      setTitle(record.title ?? "");
      setTagIds(recordTagIds);
      setCodeLanguage(record.defaultCodeLanguage ?? null);
      setPersistState("idle");
      setAutoFocusPoint(null);
      setAutoFocusEditor(true);
      setShowTagEditor(false);
    }
  }, [editing, record, recordSnapshotKey]);

  useEffect(() => {
    if (!editing || !showTagEditor) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      tagInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing, showTagEditor]);

  useEffect(() => {
    if (!editing || !active) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      const switchingToAnotherRecord =
        target instanceof Element &&
        Boolean(target.closest(".project-history-record__surface"));
      const nextValue = editorControllerRef.current?.getCommittedValue() ?? value;
      const before = draftFingerprint();
      const context = editContextRef.current;
      void persistRecord(nextValue, title, tagIds)
        .then(async () => {
          if (!isCurrentEdit(context)) return;
          if ((editorControllerRef.current?.getPendingAiReviewCount() ?? 0) > 0) throw new Error("请先接受或取消待确认的 AI 内容，草稿已保留");
          if (before !== draftFingerprint()) throw new Error("保存期间内容有更新，草稿已保留，请再次保存");
          await canonical.checkpoint("leave_editor");
          if (!isCurrentEdit(context)) return;
          if (before !== draftFingerprint() || (editorControllerRef.current?.getPendingAiReviewCount() ?? 0) > 0) throw new Error("保存期间内容有更新，草稿已保留，请再次保存");
          exitEditing({ preserveScroll: !switchingToAnotherRecord });
        }).catch(reportSaveError);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [active, editing, tagIds, title, value]);

  useEffect(() => {
    if (editing) {
      if (pendingAnchorTopRef.current === null || !scrollParentRef.current || !containerRef.current) {
        return;
      }

      const desiredTop = pendingAnchorTopRef.current;
      pendingAnchorTopRef.current = null;
      const parent = scrollParentRef.current;
      const applyAnchor = () => {
        if (!containerRef.current) {
          return;
        }

        const parentRect = parent.getBoundingClientRect();
        const nextTop = containerRef.current.getBoundingClientRect().top - parentRect.top;
        parent.scrollTop += nextTop - desiredTop;
      };

      applyAnchor();
      const frame = window.requestAnimationFrame(applyAnchor);
      return () => window.cancelAnimationFrame(frame);
    }

    if (exitScrollTopRef.current === null || !scrollParentRef.current) {
      return;
    }

    scrollParentRef.current.scrollTop = exitScrollTopRef.current;
    exitScrollTopRef.current = null;
  }, [editing]);

  async function persistRecord(
    _nextValue: RichEditorValue,
    nextTitle: string,
    nextTagIds: number[],
    origin: "manual" | "editor_ai" = "manual",
  ) {
    const context = editContextRef.current;
    const { committed, nextSignature } = submitRecord(nextTitle, nextTagIds, origin);
    setValue(committed);
    await coordinator.flush(recordSaveKey);
    if (!isCurrentEdit(context)) return;
    saveSignatureRef.current = nextSignature;
    setSaveError(null);
  }

  function submitRecord(nextTitle: string, nextTagIds: number[], origin: "manual" | "editor_ai" = "manual") {
    const editor = editorControllerRef.current;
    if (!editingReady || !editor || resolvingConflictRef.current) throw new Error("记录编辑器尚未就绪，草稿已保留");
    const committed = editor.getCommittedValue();
    const nextSignature = buildRecordSaveSignature(committed, nextTitle, nextTagIds, latest.current.codeLanguage);
    if (nextSignature !== saveSignatureRef.current && nextSignature !== submittedSignatureRef.current) {
      const canonicalBody = canonical.capture(editor.getCommittedDocumentJson(), origin);
      if (!canonicalBody) throw new Error("记录保存基线不可用，草稿已保留");
      const snapshot = { workspaceKey: workspaceRoot, recordId: record.id, title: nextTitle, tagIds: nextTagIds,
        defaultCodeLanguage: latest.current.codeLanguage, committedContent: committed, canonicalBody };
      coordinator.submit(scope.kind === "project" ? { ...snapshot, scope: "project", projectId: scope.projectId } : { ...snapshot, scope: "workspace" });
      submittedSignatureRef.current = nextSignature;
    }
    return { committed, nextSignature };
  }

  function reportSaveError(error: unknown) { setSaveError(error instanceof Error ? error.message : String(error)); }
  function draftFingerprint() { return JSON.stringify([latest.current, editorControllerRef.current?.getCommittedDocumentJson()]); }

  async function handleTitleBlur() {
    await persistRecord(editorControllerRef.current?.getCommittedValue() ?? value, title, tagIds);
  }

  async function handleTagChange(nextTagIds: number[]) {
    setTagIds(nextTagIds);
    setShowTagEditor(nextTagIds.length > 0);
    await persistRecord(editorControllerRef.current?.getCommittedValue() ?? value, title, nextTagIds);
  }

  async function saveAndExitEditing() {
    if ((editorControllerRef.current?.getPendingAiReviewCount() ?? 0) > 0) throw new Error("请先接受或取消待确认的 AI 内容，草稿已保留");
    const before = draftFingerprint();
    const context = editContextRef.current;
    await persistRecord(editorControllerRef.current?.getCommittedValue() ?? value, title, tagIds);
    if (!isCurrentEdit(context)) return false;
    if (before !== draftFingerprint() || (editorControllerRef.current?.getPendingAiReviewCount() ?? 0) > 0) throw new Error("保存期间内容有更新，草稿已保留，请再次保存");
    await canonical.checkpoint("leave_editor");
    if (!isCurrentEdit(context)) return false;
    if (before !== draftFingerprint() || (editorControllerRef.current?.getPendingAiReviewCount() ?? 0) > 0) throw new Error("保存期间内容有更新，草稿已保留，请再次保存");
    exitEditing();
    return true;
  }

  function handleEditingKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void saveAndExitEditing().catch(reportSaveError);
  }

  function enterEditing(
    point?: RichEditorAutoFocusPoint,
    options: { autoFocusEditor?: boolean } = {},
  ) {
    cancelQuickNoteRecordMetadata(record.id, projectId ?? undefined);
    setHydratedIdentity(null);
    submittedSignatureRef.current = "";
    setSaveError(null);
    const nextDraft = buildRecordDraft(record);
    setValue(nextDraft);
    saveSignatureRef.current = buildRecordSaveSignature(
      nextDraft,
      record.title ?? "",
      recordTagIds,
      record.defaultCodeLanguage ?? null,
    );
    scrollParentRef.current = containerRef.current?.closest(scrollParentSelector) ?? null;
    if (scrollParentRef.current && containerRef.current) {
      const parentRect = scrollParentRef.current.getBoundingClientRect();
      pendingAnchorTopRef.current =
        containerRef.current.getBoundingClientRect().top - parentRect.top;
    } else {
      pendingAnchorTopRef.current = null;
    }
    setAutoFocusPoint(point ?? null);
    setAutoFocusEditor(options.autoFocusEditor ?? true);
    setEditing(true);
  }

  function exitEditing(options?: { preserveScroll?: boolean }) {
    if (options?.preserveScroll !== false && scrollParentRef.current) {
      exitScrollTopRef.current = scrollParentRef.current.scrollTop;
    }
    browseEditStartedAtRef.current = null;
    setEditing(false);
  }

  async function openFocusPage() {
    cancelQuickNoteRecordMetadata(record.id, projectId ?? undefined);
    if (editing) {
      if (canonical.error && !editingReady && !coordinator.getLatestSnapshot(recordSaveKey)) exitEditing();
      else if (!await saveAndExitEditing()) return;
    }

    await onOpenFocusPage(record);
  }

  function openFocusPageFromBrowseDoubleClick(event: ReactMouseEvent) {
    if (event.button !== 0) {
      return;
    }

    const browseEditStartedAt = browseEditStartedAtRef.current;
    const isRecentBrowseEdit =
      editing &&
      browseEditStartedAt !== null &&
      Date.now() - browseEditStartedAt <= BROWSE_DOUBLE_CLICK_WINDOW_MS;

    if (!isRecentBrowseEdit && editing) {
      return;
    }

    if (!isRecentBrowseEdit && shouldIgnoreBrowseDoubleClickTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    browseEditStartedAtRef.current = null;

    if (focusPageOpeningRef.current) {
      return;
    }

    focusPageOpeningRef.current = true;
    void openFocusPage().catch(reportSaveError).finally(() => {
      focusPageOpeningRef.current = false;
    });
  }

  function handleRecordMouseDownCapture(event: ReactMouseEvent) {
    if (event.detail < 2) {
      return;
    }

    openFocusPageFromBrowseDoubleClick(event);
  }

  function handleRecordDoubleClickCapture(event: ReactMouseEvent) {
    openFocusPageFromBrowseDoubleClick(event);
  }

  async function createMentionTag(label: string) {
    const tag = await projectMindApi.projectTagUpsert({
      projectId,
      label,
      colorKey: colorKeyForTagLabel(label),
    });
    onCreatedTag?.(tag);
    return tag;
  }

  function openTagEditor(event: ReactMouseEvent | ReactKeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    setShowTagEditor(true);

    if (!editing) {
      enterEditing(undefined, { autoFocusEditor: false });
    } else {
      setAutoFocusEditor(false);
    }
  }

  function renderHeaderAddTagButton() {
    if (!shouldShowHeaderAddTag) {
      return null;
    }

    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="project-history-record__header-tag-button"
        leadingIcon={<Plus size={13} />}
        aria-label="添加标签"
        onMouseDown={openTagEditor}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            openTagEditor(event);
          }
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        #标签
      </Button>
    );
  }

  function renderRecordActions() { return <>
          <IconButton
            type="button"
            size="sm"
            variant="ghost"
            aria-label="打开专注页"
            onMouseDown={(event) => {
              if (!editing) {
                event.stopPropagation();
              }
            }}
            onClick={(event) => {
              if (!editing) {
                event.stopPropagation();
              }
              void openFocusPage().catch(reportSaveError);
            }}
          >
            <ExternalLink size={15} />
          </IconButton>
  </>; }

  function renderHeader() {
    return (
      <div className="project-history-record__header">
        <div className="project-history-record__header-main">
          {editing ? (
            <TextField
              value={title}
              placeholder="记录标题"
              disabled={!editingReady || !active}
              className="project-history-record__title-input"
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void handleTitleBlur().catch(reportSaveError)}
            />
          ) : (
            <p className="project-history-record__title">{titleDisplay}{record.isVoice ? <VoiceRecordIcon className="project-history-record__voice-icon" size={15} aria-label="语音记录" /> : null}</p>
          )}
        </div>
        <div className="project-history-record__header-actions">
          {renderHeaderAddTagButton()}
          {editing ? (
            <span
              className={cn(
                "project-history-record__save-indicator",
                persistState === "saving" && "project-history-record__save-indicator--saving",
                persistState === "saved" && "project-history-record__save-indicator--saved",
                persistState === "error" && "project-history-record__save-indicator--error",
              )}
            >
              {busy || persistState === "saving"
                ? "保存中..."
                : persistState === "saved"
                  ? "已保存"
                  : persistState === "error"
                    ? "保存失败"
                    : "自动保存"}
            </span>
          ) : (
            <div className="project-history-record__meta">
              <span>{homepage ? formatHomeTimestamp(record.updatedAt) : `更新于 ${formatDateTime(record.updatedAt)}`}</span>
            </div>
          )}
          {!homepage || editing ? renderRecordActions() : null}
        </div>
      </div>
    );
  }

  function renderTagRow() {
    if (editing) {
      if (!shouldShowEditingTagRow) {
        return null;
      }

      return (
        <div className="project-history-record__tag-row">
          <EntityTagEditor
            inputPlaceholder="新增标签"
            projectId={projectId}
            availableTags={availableTags}
            tags={selectedTags}
            busy={busy || !editingReady || !active}
            inputRef={tagInputRef}
            onChange={(nextTagIds) => void handleTagChange(nextTagIds).catch(reportSaveError)}
            onCreated={onCreatedTag}
          />
        </div>
      );
    }

    if (recordTags.length === 0) {
      return null;
    }

    return (
      <div className="project-history-record__tag-row" aria-label="记录标签">
        <EntityTagEditor tags={recordTags} availableTags={availableTags} mode="display" onChange={() => undefined} />
      </div>
    );
  }

  function renderHeaderStack() {
    const hasTagRow = editing ? shouldShowEditingTagRow : recordTags.length > 0;

    return (
      <div
        className={cn(
          "project-history-record__header-stack",
          !hasTagRow && "project-history-record__header-stack--compact",
        )}
      >
        {renderHeader()}
        {!homepage || editing ? renderTagRow() : null}
      </div>
    );
  }

  return (
    <article
      id={`record-${record.id}`}
      ref={containerRef}
      onMouseDownCapture={homepage && !editing ? undefined : handleRecordMouseDownCapture}
      onDoubleClickCapture={homepage && !editing ? undefined : handleRecordDoubleClickCapture}
      onContextMenu={(event) => {
        if (editing && shouldLetRichEditorHandleContextMenu(event.target)) {
          return;
        }

        onOpenContextMenu(event, record.id);
      }}
      className={cn(
        "project-history-record",
        focused && "scroll-mt-6",
        editing && "project-history-record--editing",
      )}
    >
      {editing ? (
        <div className="project-history-record__editor" onKeyDownCapture={handleEditingKeyDown}>
          {renderHeaderStack()}
          {saveError || canonical.error || canonical.syncError ? <p role="alert" className="text-ui text-danger">{saveError ?? String(canonical.error ?? canonical.syncError)}</p> : null}
          {!editingReady && !canonical.error ? <p role="status" className="text-ui text-text-soft">正在准备记录编辑器…</p> : null}
          {canonical.error ? <Button type="button" size="sm" variant="ghost" onClick={canonical.retry}>重新加载编辑器</Button> : null}
          {canonical.incomingConflict && canonical.binding ? <RecordConflictActions visible={active} binding={canonical.binding} target={canonical.incomingConflict.head.target}
            incoming={canonical.incomingConflict} workspaceRoot={workspaceRoot} availableTags={availableTags} assetHandlers={scope.assetHandlers}
            pendingReviewCount={() => editorControllerRef.current?.getPendingAiReviewCount() ?? 0}
            getDraft={() => {
              const editor = editorControllerRef.current;
              if (!editor) throw new Error("编辑器尚未就绪，草稿已保留");
              return { title: latest.current.title, tagIds: [...latest.current.tagIds], codeLanguage: latest.current.codeLanguage,
                document: editor.getCommittedDocumentJson(), html: editor.getCommittedValue().html };
            }}
            onReload={() => { coordinator.discard(recordSaveKey); resolvingConflictRef.current = true; canonical.retry(); }}
            onSavedAs={(state) => {
              coordinator.discard(recordSaveKey); resolvingConflictRef.current = true; canonical.retry();
              return onOpenFocusPage({ ...record, ...state.record });
            }} /> : null}
          <div className="project-history-record__content">
            {canonical.error ? <RichTextViewer html={getRenderableRichTextHtml({ html: record.contentHtml, markdown: record.contentMarkdown })} /> : <RichEditor
              key={canonical.loadIdentity ?? `${recordSaveKey}:loading`}
              recordKey={canonical.recordKey}
              recordClipboard={recordClipboard}
              readOnly={!editingReady || !active || Boolean(canonical.error)}
              contentIdentity={scope.kind === "project"
                ? `project-record:${scope.projectId}:${record.id}`
                : `workspace-record:${record.id}`}
              html={value.html}
              aiSettings={aiSettings}
              defaultCodeLanguage={codeLanguage}
              onDefaultCodeLanguageChange={setCodeLanguage}
              variant="bare"
              autoFocus={autoFocusEditor ? autoFocusPoint ?? true : false}
              assetHandlers={scope.assetHandlers}
              placeholder="写记录，正文里的 #标签 会自动同步。"
              tagMentions={{
                projectId,
                availableTags,
                onCreateTag: createMentionTag,
              }}
              internalReferences={{
                context: internalReferenceContext,
                onOpenReference: onOpenInternalReference,
              }}
              contactMentions={contactMentionOptions}
              autosave={{
                delay: 120000,
                onBlur: true,
                onWindowBlur: true,
                onVisibilityChange: true,
              }}
              controllerRef={editorControllerRef}
              onOpenAiSettings={onOpenAiSettings}
              onPersistStateChange={setPersistState}
              onSave={(nextValue) => persistRecord(nextValue, title, tagIds)}
              onBeforeAiCommit={() => {
                try { submitRecord(latest.current.title, latest.current.tagIds); return true; }
                catch (error) { reportSaveError(error); return false; }
              }}
              onAiCommit={(nextValue) => { void persistRecord(nextValue, latest.current.title, latest.current.tagIds, "editor_ai").catch(reportSaveError); }}
            />}
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          className="project-history-record__surface"
          onClick={homepage ? () => { void openFocusPage().catch(reportSaveError); } : undefined}
          onMouseDown={(event) => {
            if (homepage || event.button !== 0) {
              return;
            }

            const contentSurface = event.currentTarget.querySelector(
              ".project-history-record__content .rich-editor__surface",
            ) as HTMLElement | null;

            if (!contentSurface) {
              browseEditStartedAtRef.current = Date.now();
              enterEditing();
              return;
            }

            const contentRect = contentSurface.getBoundingClientRect();
            browseEditStartedAtRef.current = Date.now();
            enterEditing({
              x: Math.max(0, event.clientX - contentRect.left),
              y: Math.max(0, event.clientY - contentRect.top),
              mode: "content-relative",
            });
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") {
              return;
            }

            event.preventDefault();
            if (homepage) void openFocusPage().catch(reportSaveError);
            else enterEditing();
          }}
        >
          {renderHeaderStack()}
          {homepage ? <HomeRecordPreview html={record.contentHtml} markdown={record.contentMarkdown} active={active} /> : <CollapsibleRecordContent>
            <RichTextViewer
              html={record.contentHtml}
              markdown={record.contentMarkdown}
              active={active}
              deferUntilVisible
              eagerManagedImages
            />
          </CollapsibleRecordContent>}
          {homepage && recordTags.length > 0 ? <div className="home-record-footer"><div className="home-record-tags">{renderTagRow()}</div></div> : null}
        </div>
      )}
    </article>
  );
}

function CollapsibleRecordContent({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  function resolveListContainer() {
    const item = contentRef.current?.closest("[data-layout-motion-id]") ?? null;
    return item?.closest("[data-list-layout-motion]") ?? null;
  }
  const expandedPresence = useMotionPresence(expanded, {
    commitExit: (update) => {
      commitListLayoutChange(resolveListContainer(), update);
    },
  });
  const visuallyExpanded = expanded || expandedPresence.mounted;

  useEffect(() => {
    setExpanded(false);
  }, [children]);

  useEffect(() => {
    const content = contentRef.current;

    if (!content) {
      return;
    }

    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const nextCanCollapse =
          content.scrollHeight > RECORD_COLLAPSED_CONTENT_HEIGHT + COLLAPSE_OVERFLOW_TOLERANCE;
        setCanCollapse(nextCanCollapse);
        setExpanded((current) => (nextCanCollapse ? current : false));
      });
    };

    measure();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(content);
    content.querySelectorAll("img").forEach((image) => {
      image.addEventListener("load", measure);
      image.addEventListener("error", measure);
    });
    window.addEventListener("resize", measure);

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      content.querySelectorAll("img").forEach((image) => {
        image.removeEventListener("load", measure);
        image.removeEventListener("error", measure);
      });
      window.removeEventListener("resize", measure);
    };
  }, [children]);

  function stopCardActivation(event: ReactMouseEvent | ReactKeyboardEvent) {
    event.stopPropagation();
  }

  function toggleExpanded() {
    commitListLayoutChange(resolveListContainer(), () => setExpanded((current) => !current));
  }

  return (
    <div className="project-history-record__content">
      <div
        ref={contentRef}
        className={cn(
          "project-history-record__collapsible",
          canCollapse && !visuallyExpanded && "project-history-record__collapsible--collapsed",
        )}
        data-reveal={
          expanded && !expandedPresence.mounted
            ? "entering"
            : expandedPresence.mounted
              ? expandedPresence.state
              : "open"
        }
        onTransitionEnd={expandedPresence.onTransitionEnd}
        style={
          canCollapse && !visuallyExpanded
            ? { maxHeight: `${RECORD_COLLAPSED_CONTENT_HEIGHT}px` }
            : undefined
        }
      >
        {children}
      </div>
      {canCollapse ? (
        <div className="project-history-record__expand-row">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="project-history-record__expand-button"
            leadingIcon={expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            onMouseDown={stopCardActivation}
            onKeyDown={stopCardActivation}
            onClick={(event) => {
              event.stopPropagation();
              toggleExpanded();
            }}
          >
            {expanded ? "收起" : "展开全部"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function shouldLetRichEditorHandleContextMenu(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        ".rich-editor__surface, .rich-editor__toolbar, .rich-editor__ai-menu, .rich-editor__table-toolbar, .rich-editor__code-language-popover, .context-menu__panel",
      ),
    )
  );
}

function shouldIgnoreBrowseDoubleClickTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "button, a, input, textarea, select, [contenteditable='true'], .context-menu__panel",
      ),
    )
  );
}

function buildRecordDraft(record: RecordListItemRecord): RichEditorValue {
  return {
    html: getRenderableRichTextHtml({
      html: record.contentHtml,
      markdown: record.contentMarkdown,
    }),
    text: record.contentMarkdown,
    markdown: record.contentMarkdown,
  };
}

function buildRecordSaveSignature(
  value: RichEditorValue,
  title: string,
  tagIds: number[],
  defaultCodeLanguage: string | null,
) {
  const normalized = normalizeRichEditorValue(value);
  const normalizedTagIds = [...tagIds].sort((left, right) => left - right);
  return JSON.stringify({
    title: title.trim(),
    markdown: normalized.markdown,
    html: normalized.html,
    tagIds: normalizedTagIds,
    defaultCodeLanguage,
  });
}

function formatHomeTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
