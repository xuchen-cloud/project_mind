import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { ExternalLink, Save, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { fileTagColorValue } from "../../lib/constants";
import { formatDateTime } from "../../lib/formatters";
import { withPageWidthClass } from "../../lib/pageWidth";
import { colorKeyForTagLabel } from "../../lib/tags";
import { projectMindApi } from "../../services/projectMindApi";
import type { DocumentTagRecord, FileTagRecord, WorkspaceRecord } from "../../lib/types";
import type { PageWidthMode } from "../../state/ui-store";
import { ActionContextMenu, Button, EmptyState, IconButton, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import {
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  RichTextViewer,
  type RichEditorAutoFocusPoint,
  type RichEditorAssetHandlers,
  type RichEditorController,
  type RichEditorContactMentionOptions,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";
import { EntityTagEditor } from "../tags/EntityTagEditor";

const EMPTY_VALUE: RichEditorValue = { html: "", text: "", markdown: "" };

interface WorkspaceOverviewHistoryProps {
  notes: WorkspaceRecord[];
  hasAnyNotes: boolean;
  focusId: string | null;
  composeRecord: boolean;
  pageWidthMode: PageWidthMode;
  availableTags: FileTagRecord[];
  saving?: boolean;
  onCreateRecord: (input: {
    title?: string;
    markdown: string;
    html: string;
    tagIds?: number[];
  }) => Promise<unknown>;
  onUpdateRecord: (
    note: WorkspaceRecord,
    input: { title?: string; markdown: string; html: string; tagIds?: number[] },
  ) => Promise<unknown>;
  onDeleteRecord: (noteId: number) => Promise<unknown>;
  onCloseCompose: () => void;
  contactMentionOptions: RichEditorContactMentionOptions;
  onOpenInternalReference: (reference: unknown) => Promise<boolean> | boolean;
  assetHandlers?: RichEditorAssetHandlers;
  active?: boolean;
}

export function WorkspaceOverviewHistory({
  notes,
  hasAnyNotes,
  focusId,
  composeRecord,
  pageWidthMode,
  availableTags,
  saving = false,
  onCreateRecord,
  onUpdateRecord,
  onDeleteRecord,
  onCloseCompose,
  contactMentionOptions,
  onOpenInternalReference,
  assetHandlers,
  active = true,
}: WorkspaceOverviewHistoryProps) {
  const queryClient = useQueryClient();
  const [recordDraftTitle, setRecordDraftTitle] = useState("");
  const [recordDraftValue, setRecordDraftValue] = useState<RichEditorValue>(EMPTY_VALUE);
  const [recordDraftTagIds, setRecordDraftTagIds] = useState<number[]>([]);
  const [savingRecordId, setSavingRecordId] = useState<number | null>(null);
  const [recordContextMenu, setRecordContextMenu] = useState<{
    x: number;
    y: number;
    noteId: number;
  } | null>(null);
  const recordDraftEditorRef = useRef<RichEditorController | null>(null);
  const contextMenuNote = recordContextMenu
    ? notes.find((note) => note.id === recordContextMenu.noteId) ?? null
    : null;

  useEffect(() => {
    if (recordContextMenu && !contextMenuNote) {
      setRecordContextMenu(null);
    }
  }, [contextMenuNote, recordContextMenu]);

  function syncWorkspaceTagCache(tag: FileTagRecord) {
    queryClient.setQueryData<{ tags: FileTagRecord[] } | undefined>(
      ["file-tag-settings", "workspace"],
      (current) => {
        const tags = current?.tags ?? [];
        if (tags.some((item) => item.id === tag.id)) {
          return current ?? { tags };
        }

        return {
          tags: [...tags, tag].sort((left, right) =>
            left.label.localeCompare(right.label, "zh-Hans-CN"),
          ),
        };
      },
    );
  }

  async function createRecord() {
    const normalized = normalizeRichEditorValue(
      recordDraftEditorRef.current?.getValue() ?? recordDraftValue,
    );
    if (!normalized.markdown.trim()) {
      return;
    }

    await onCreateRecord({
      title: recordDraftTitle.trim() || undefined,
      markdown: normalized.markdown,
      html: normalized.html,
      tagIds: recordDraftTagIds,
    });
    setRecordDraftTitle("");
    setRecordDraftValue(EMPTY_VALUE);
    setRecordDraftTagIds([]);
    onCloseCompose();
  }

  function openRecordContextMenu(event: ReactMouseEvent, noteId: number) {
    event.preventDefault();
    event.stopPropagation();
    setRecordContextMenu({ x: event.clientX, y: event.clientY, noteId });
  }

  return (
    <section
      className={withPageWidthClass(
        "project-overview-focus__page project-overview-focus__page--history",
        pageWidthMode,
        "history",
      )}
      data-testid="workspace-page-body-record"
    >
      {composeRecord ? (
        <article className="project-history-record project-history-record--draft project-history-record--editing">
          <div className="project-history-record__editor">
            <div className="project-history-record__header">
              <div className="project-history-record__header-main">
                <TextField
                  aria-label="记录标题"
                  value={recordDraftTitle}
                  placeholder="记录标题"
                  className="project-history-record__title-input"
                  onChange={(event) => setRecordDraftTitle(event.target.value)}
                />
              </div>
              <div className="project-history-record__header-actions">
                <span className="project-history-record__save-indicator">创建前不会保存</span>
              </div>
            </div>
            <div className="project-history-record__tag-row">
              <EntityTagEditor
                projectId={null}
                availableTags={availableTags}
                tags={availableTags.filter((tag) => recordDraftTagIds.includes(tag.id))}
                onChange={(tagIds) => setRecordDraftTagIds(tagIds)}
                onCreated={syncWorkspaceTagCache}
              />
            </div>
            <RichEditor
              html={recordDraftValue.html}
              variant="bare"
              autoFocus
              assetHandlers={assetHandlers}
              placeholder="写记录，正文里的 #标签 会自动同步。"
              tagMentions={{
                projectId: null,
                availableTags,
                onCreateTag: async (label) => {
                  const tag = await projectMindApi.fileTagOptionUpsert({
                    label,
                    colorKey: colorKeyForTagLabel(label),
                  });
                  syncWorkspaceTagCache(tag);
                  return tag;
                },
              }}
              internalReferences={{
                context: { scope: "workspace" },
                onOpenReference: onOpenInternalReference as never,
              }}
              contactMentions={contactMentionOptions}
              controllerRef={recordDraftEditorRef}
            />
            <div className="project-history-record__composer-actions">
              <Button type="button" size="sm" variant="ghost" onClick={onCloseCompose}>
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                leadingIcon={<Save size={14} />}
                onClick={() => void createRecord()}
              >
                保存记录
              </Button>
            </div>
          </div>
        </article>
      ) : null}

      {notes.length > 0 ? (
        <div className="grid gap-2.5">
          {notes.map((note) => (
            <WorkspaceHistoryRecordRow
              key={note.id}
              note={note}
              focused={focusId === `record-${note.id}`}
              availableTags={availableTags}
              busy={saving || savingRecordId === note.id}
              onSave={async (current, value, title, tagIds) => {
                setSavingRecordId(current.id);
                try {
                  const normalized = normalizeRichEditorValue(value);
                  await onUpdateRecord(current, {
                    title: title.trim() || undefined,
                    markdown: normalized.markdown,
                    html: normalized.html,
                    tagIds,
                  });
                } finally {
                  setSavingRecordId(null);
                }
              }}
              onOpenContextMenu={openRecordContextMenu}
              contactMentionOptions={contactMentionOptions}
              onOpenInternalReference={onOpenInternalReference}
              assetHandlers={assetHandlers}
              active={active}
            />
          ))}
        </div>
      ) : !hasAnyNotes ? (
        <EmptyState text="还没有记录。" compact />
      ) : (
        <EmptyState text="没有匹配的记录。" compact />
      )}
      {contextMenuNote && recordContextMenu ? (
        <ActionContextMenu
          x={recordContextMenu.x}
          y={recordContextMenu.y}
          ariaLabel="记录操作"
          actions={[
            {
              label: "删除",
              icon: Trash2,
              tone: "danger",
              onSelect: () => {
                setRecordContextMenu(null);
                void onDeleteRecord(contextMenuNote.id);
              },
            },
          ]}
          onClose={() => setRecordContextMenu(null)}
        />
      ) : null}
    </section>
  );
}

function WorkspaceHistoryRecordRow({
  note,
  focused,
  availableTags,
  busy,
  onSave,
  onOpenContextMenu,
  contactMentionOptions,
  onOpenInternalReference,
  assetHandlers,
  active,
}: {
  note: WorkspaceRecord;
  focused: boolean;
  availableTags: FileTagRecord[];
  busy: boolean;
  onSave: (
    note: WorkspaceRecord,
    value: RichEditorValue,
    title: string,
    tagIds: number[],
  ) => Promise<void>;
  onOpenContextMenu: (event: ReactMouseEvent, noteId: number) => void;
  contactMentionOptions: RichEditorContactMentionOptions;
  onOpenInternalReference: (reference: unknown) => Promise<boolean> | boolean;
  assetHandlers?: RichEditorAssetHandlers;
  active: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const navigate = useNavigate();
  const [autoFocusPoint, setAutoFocusPoint] = useState<RichEditorAutoFocusPoint | null>(null);
  const [title, setTitle] = useState(note.title ?? "");
  const [value, setValue] = useState<RichEditorValue>(() => buildWorkspaceDraft(note));
  const [tagIds, setTagIds] = useState<number[]>((note.tags ?? []).map((tag) => tag.id));
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const queryClient = useQueryClient();
  const containerRef = useRef<HTMLElement | null>(null);
  const editorControllerRef = useRef<RichEditorController | null>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);
  const exitScrollTopRef = useRef<number | null>(null);
  const pendingAnchorTopRef = useRef<number | null>(null);
  const saveSignatureRef = useRef(
    buildRecordSaveSignature(buildWorkspaceDraft(note), note.title ?? "", tagIds),
  );

  const noteTags = note.tags ?? [];
  const titleDisplay = note.title?.trim() || "未命名记录";

  function syncWorkspaceTagCache(tag: FileTagRecord) {
    queryClient.setQueryData<{ tags: FileTagRecord[] } | undefined>(
      ["file-tag-settings", "workspace"],
      (current) => {
        const tags = current?.tags ?? [];
        if (tags.some((item) => item.id === tag.id)) {
          return current ?? { tags };
        }

        return {
          tags: [...tags, tag].sort((left, right) =>
            left.label.localeCompare(right.label, "zh-Hans-CN"),
          ),
        };
      },
    );
  }

  useEffect(() => {
    if (!editing) {
      const nextTagIds = (note.tags ?? []).map((tag) => tag.id);
      setTitle(note.title ?? "");
      setAutoFocusPoint(null);
      setValue(buildWorkspaceDraft(note));
      setTagIds(nextTagIds);
      setPersistState("idle");
      saveSignatureRef.current = buildRecordSaveSignature(
        buildWorkspaceDraft(note),
        note.title ?? "",
        nextTagIds,
      );
    }
  }, [editing, note]);

  useEffect(() => {
    if (!editing || !active) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (containerRef.current?.contains(target)) return;
      const switchingToAnotherRecord =
        target instanceof Element &&
        Boolean(target.closest(".project-history-record__surface"));
      const nextValue = editorControllerRef.current?.getValue() ?? value;
      void persistRecord(nextValue, title, tagIds)
        .catch(() => undefined)
        .finally(() => {
          exitEditing({ preserveScroll: !switchingToAnotherRecord });
        });
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
    nextValue: RichEditorValue,
    nextTitle: string,
    nextTagIds: number[],
  ) {
    const nextSignature = buildRecordSaveSignature(nextValue, nextTitle, nextTagIds);
    if (nextSignature === saveSignatureRef.current) return;
    await onSave(note, nextValue, nextTitle, nextTagIds);
    saveSignatureRef.current = nextSignature;
  }

  async function handleTitleBlur() {
    await persistRecord(editorControllerRef.current?.getValue() ?? value, title, tagIds);
  }

  async function handleTagChange(nextTagIds: number[]) {
    setTagIds(nextTagIds);
    await persistRecord(editorControllerRef.current?.getValue() ?? value, title, nextTagIds);
  }

  async function saveAndExitEditing() {
    await persistRecord(editorControllerRef.current?.getValue() ?? value, title, tagIds);
    exitEditing();
  }

  function handleEditingKeyDown(event: ReactKeyboardEvent) {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void saveAndExitEditing();
  }

  function enterEditing(point?: RichEditorAutoFocusPoint) {
    scrollParentRef.current =
      containerRef.current?.closest("[data-testid='workspace-overview-focus-scroll']") ?? null;
    if (scrollParentRef.current && containerRef.current) {
      const parentRect = scrollParentRef.current.getBoundingClientRect();
      pendingAnchorTopRef.current =
        containerRef.current.getBoundingClientRect().top - parentRect.top;
    } else {
      pendingAnchorTopRef.current = null;
    }
    setAutoFocusPoint(point ?? null);
    setEditing(true);
  }

  function exitEditing(options?: { preserveScroll?: boolean }) {
    if (options?.preserveScroll !== false && scrollParentRef.current) {
      exitScrollTopRef.current = scrollParentRef.current.scrollTop;
    }
    setEditing(false);
  }

  async function openFocusPage() {
    if (editing) {
      await persistRecord(editorControllerRef.current?.getValue() ?? value, title, tagIds);
    }

    navigate(`/workspace/records/${note.id}`);
  }

  return (
    <article
      id={`record-${note.id}`}
      ref={containerRef}
      onContextMenu={(event) => {
        if (editing && shouldLetRichEditorHandleContextMenu(event.target)) {
          return;
        }

        onOpenContextMenu(event, note.id);
      }}
      className={cn(
        "project-history-record",
        focused && "scroll-mt-6",
        editing && "project-history-record--editing",
      )}
    >
      {editing ? (
        <div className="project-history-record__editor" onKeyDownCapture={handleEditingKeyDown}>
          <div className="project-history-record__header">
            <div className="project-history-record__header-main">
              <TextField
                value={title}
                placeholder="记录标题"
                className="project-history-record__title-input"
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => void handleTitleBlur()}
              />
            </div>
            <div className="project-history-record__header-actions">
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
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                aria-label="打开专注页"
                onClick={() => void openFocusPage()}
              >
                <ExternalLink size={15} />
              </IconButton>
            </div>
          </div>
          <div className="project-history-record__tag-row">
            <EntityTagEditor
              projectId={null}
              availableTags={availableTags}
              tags={availableTags.filter((tag) => tagIds.includes(tag.id))}
              busy={busy}
              onChange={(nextTagIds) => void handleTagChange(nextTagIds)}
              onCreated={syncWorkspaceTagCache}
            />
          </div>
          <div className="project-history-record__content">
            <RichEditor
              html={value.html}
              variant="bare"
              autoFocus={autoFocusPoint ?? true}
              assetHandlers={assetHandlers}
              placeholder="写记录，正文里的 #标签 会自动同步。"
              tagMentions={{
                projectId: null,
                availableTags,
                onCreateTag: async (label) => {
                  const tag = await projectMindApi.fileTagOptionUpsert({
                    label,
                    colorKey: colorKeyForTagLabel(label),
                  });
                  syncWorkspaceTagCache(tag);
                  return tag;
                },
              }}
              internalReferences={{
                context: { scope: "workspace" },
                onOpenReference: onOpenInternalReference as never,
              }}
              contactMentions={contactMentionOptions}
              autosave={{
                delay: 120000,
                onBlur: true,
                onWindowBlur: true,
                onVisibilityChange: true,
              }}
              controllerRef={editorControllerRef}
              onPersistStateChange={setPersistState}
              onSave={(nextValue) => persistRecord(nextValue, title, tagIds)}
            />
          </div>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          className="project-history-record__surface"
          onMouseDown={(event) => {
            if (event.button !== 0) {
              return;
            }

            const contentSurface = event.currentTarget.querySelector(
              ".project-history-record__content .rich-editor__surface",
            ) as HTMLElement | null;

            if (!contentSurface) {
              enterEditing();
              return;
            }

            const contentRect = contentSurface.getBoundingClientRect();
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
            enterEditing();
          }}
        >
          <div className="project-history-record__header">
            <div className="project-history-record__header-main">
              <p className="project-history-record__title">{titleDisplay}</p>
            </div>
            <div className="project-history-record__header-actions">
              <div className="project-history-record__meta">
                <span>更新于 {formatDateTime(note.updatedAt)}</span>
              </div>
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                aria-label="打开专注页"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void openFocusPage();
                }}
              >
                <ExternalLink size={15} />
              </IconButton>
            </div>
          </div>
          <div
            className={cn(
              "project-history-record__tag-row",
              noteTags.length === 0 && "project-history-record__tag-row--empty",
            )}
            aria-label={noteTags.length > 0 ? "记录标签" : undefined}
          >
            {noteTags.length > 0 ? (
              <div className="project-history-record__tag-list">
                {noteTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="project-history-record__tag"
                    style={{
                      backgroundColor: `color-mix(in srgb, ${fileTagColorValue(tag.colorKey)} 12%, transparent)`,
                      color: fileTagColorValue(tag.colorKey),
                    }}
                  >
                    <span
                      className="project-history-record__tag-dot"
                      style={{ backgroundColor: fileTagColorValue(tag.colorKey) }}
                      aria-hidden="true"
                    />
                    {tag.label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="project-history-record__content">
            <RichTextViewer
              html={getRenderableRichTextHtml({
                html: note.contentHtml,
                markdown: note.contentMarkdown,
              })}
              deferUntilVisible
              active={active}
            />
          </div>
        </div>
      )}
    </article>
  );
}

function shouldLetRichEditorHandleContextMenu(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        ".rich-editor__surface, .rich-editor__toolbar, .rich-editor__ai-menu, .rich-editor__table-toolbar, .context-menu__panel",
      ),
    )
  );
}

function buildWorkspaceDraft(note: WorkspaceRecord): RichEditorValue {
  return {
    html: getRenderableRichTextHtml({
      html: note.contentHtml,
      markdown: note.contentMarkdown,
    }),
    text: note.contentMarkdown,
    markdown: note.contentMarkdown,
  };
}

function buildRecordSaveSignature(
  value: RichEditorValue,
  title: string,
  tagIds: number[],
) {
  const normalized = normalizeRichEditorValue(value);
  const normalizedTagIds = [...tagIds].sort((left, right) => left - right);
  return JSON.stringify({
    title: title.trim(),
    markdown: normalized.markdown,
    html: normalized.html,
    tagIds: normalizedTagIds,
  });
}
