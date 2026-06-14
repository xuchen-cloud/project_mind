import { useEffect, useRef, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

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
}: WorkspaceOverviewHistoryProps) {
  const queryClient = useQueryClient();
  const [recordDraftTitle, setRecordDraftTitle] = useState("");
  const [recordDraftValue, setRecordDraftValue] = useState<RichEditorValue>(EMPTY_VALUE);
  const [recordDraftTagIds, setRecordDraftTagIds] = useState<number[]>([]);
  const [savingRecordId, setSavingRecordId] = useState<number | null>(null);
  const recordDraftEditorRef = useRef<RichEditorController | null>(null);

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
                projectId={0}
                availableTags={availableTags}
                tags={availableTags.filter((tag) => recordDraftTagIds.includes(tag.id))}
                onChange={(tagIds) => setRecordDraftTagIds(tagIds)}
                onCreated={() => undefined}
              />
            </div>
            <RichEditor
              html={recordDraftValue.html}
              variant="bare"
              autoFocus
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
              onDelete={onDeleteRecord}
              contactMentionOptions={contactMentionOptions}
              onOpenInternalReference={onOpenInternalReference}
            />
          ))}
        </div>
      ) : !hasAnyNotes ? (
        <EmptyState text="还没有记录。" compact />
      ) : (
        <EmptyState text="没有匹配的记录。" compact />
      )}
    </section>
  );
}

function WorkspaceHistoryRecordRow({
  note,
  focused,
  availableTags,
  busy,
  onSave,
  onDelete,
  contactMentionOptions,
  onOpenInternalReference,
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
  onDelete: (noteId: number) => Promise<unknown>;
  contactMentionOptions: RichEditorContactMentionOptions;
  onOpenInternalReference: (reference: unknown) => Promise<boolean> | boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [autoFocusPoint, setAutoFocusPoint] = useState<RichEditorAutoFocusPoint | null>(null);
  const [title, setTitle] = useState(note.title ?? "");
  const [value, setValue] = useState<RichEditorValue>(() => buildWorkspaceDraft(note));
  const [tagIds, setTagIds] = useState<number[]>((note.tags ?? []).map((tag) => tag.id));
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
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
  const hasContent = note.contentMarkdown.trim().length > 0;

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
    if (!editing) return;

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
  }, [editing, tagIds, title, value]);

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

  return (
    <article
      id={`record-${note.id}`}
      ref={containerRef}
      className={cn(
        "project-history-record",
        focused && "scroll-mt-6",
        editing && "project-history-record--editing",
      )}
    >
      {editing ? (
        <div className="project-history-record__editor">
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
            </div>
          </div>
          <div className="project-history-record__tag-row">
            <EntityTagEditor
              projectId={0}
              availableTags={availableTags}
              tags={availableTags.filter((tag) => tagIds.includes(tag.id))}
              busy={busy}
              onChange={(nextTagIds) => void handleTagChange(nextTagIds)}
              onCreated={() => undefined}
            />
          </div>
          <RichEditor
            html={value.html}
            variant="bare"
            autoFocus={autoFocusPoint ?? true}
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
      ) : (
        <button
          type="button"
          className="project-history-record__surface"
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu({ x: event.clientX, y: event.clientY });
          }}
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
        >
          <div className="project-history-record__header">
            <div className="project-history-record__header-main">
              <p className="project-history-record__title">{titleDisplay}</p>
            </div>
            <div className="project-history-record__meta">
              <span>更新于 {formatDateTime(note.updatedAt)}</span>
              <span>{hasContent ? "点按编辑" : "等待补充内容"}</span>
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
            />
          </div>
          <div className="mt-3 flex justify-end">
            <IconButton
              type="button"
              size="sm"
              variant="ghost"
              aria-label="删除记录"
              onClick={(event) => {
                event.stopPropagation();
                void onDelete(note.id);
              }}
            >
              ×
            </IconButton>
          </div>
        </button>
      )}
      {contextMenu ? (
        <ActionContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="记录操作"
          actions={[
            {
              label: "删除",
              icon: Trash2,
              tone: "danger",
              onSelect: () => {
                setContextMenu(null);
                void onDelete(note.id);
              },
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </article>
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
