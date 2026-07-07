import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp, ExternalLink, Plus } from "lucide-react";

import { fileTagColorValue } from "../../lib/constants";
import { formatDateTime } from "../../lib/formatters";
import { colorKeyForTagLabel } from "../../lib/tags";
import { projectMindApi } from "../../services/projectMindApi";
import { Button, IconButton, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
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
  FileTagRecord,
  InternalReferenceContext,
} from "../../lib/types";
import type { InternalReferenceTarget } from "../../lib/internalReferences";

const RECORD_COLLAPSED_CONTENT_HEIGHT = 320;
const COLLAPSE_OVERFLOW_TOLERANCE = 2;
const BROWSE_DOUBLE_CLICK_WINDOW_MS = 650;

export interface RecordListItemRecord {
  id: number;
  title?: string | null;
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
      activityId?: number | null;
      assetHandlers: RichEditorAssetHandlers;
    };

interface RecordListItemProps<TRecord extends RecordListItemRecord> {
  record: TRecord;
  scope: RecordListItemScope;
  focused: boolean;
  availableTags: FileTagRecord[];
  busy: boolean;
  active: boolean;
  aiSettings: AiSettingsSnapshot | null;
  contactMentionOptions: RichEditorContactMentionOptions;
  scrollParentSelector: string;
  onSave: (
    record: TRecord,
    value: RichEditorValue,
    title: string,
    tagIds: number[],
    defaultCodeLanguage: string | null,
  ) => Promise<void>;
  onOpenFocusPage: (record: TRecord) => Promise<void> | void;
  onOpenContextMenu: (event: ReactMouseEvent, recordId: number) => void;
  onOpenInternalReference: (reference: InternalReferenceTarget) => Promise<boolean> | boolean;
  onCreatedTag?: (tag: FileTagRecord) => void;
  onOpenAiSettings: () => void;
}

export function RecordListItem<TRecord extends RecordListItemRecord>({
  record,
  scope,
  focused,
  availableTags,
  busy,
  active,
  aiSettings,
  contactMentionOptions,
  scrollParentSelector,
  onSave,
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
  const [value, setValue] = useState<RichEditorValue>(() => buildRecordDraft(record));
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
  const saveSignatureRef = useRef(
    buildRecordSaveSignature(
      buildRecordDraft(record),
      record.title ?? "",
      tagIds,
      record.defaultCodeLanguage ?? null,
    ),
  );

  const renderableHtml = getRenderableRichTextHtml({
    html: record.contentHtml,
    markdown: record.contentMarkdown,
  });
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
      setValue(buildRecordDraft(record));
      setTagIds(recordTagIds);
      setCodeLanguage(record.defaultCodeLanguage ?? null);
      setPersistState("idle");
      setAutoFocusPoint(null);
      setAutoFocusEditor(true);
      setShowTagEditor(false);
      saveSignatureRef.current = buildRecordSaveSignature(
        buildRecordDraft(record),
        record.title ?? "",
        recordTagIds,
        record.defaultCodeLanguage ?? null,
      );
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
    const nextSignature = buildRecordSaveSignature(nextValue, nextTitle, nextTagIds, codeLanguage);
    if (nextSignature === saveSignatureRef.current) return;
    await onSave(record, nextValue, nextTitle, nextTagIds, codeLanguage);
    saveSignatureRef.current = nextSignature;
  }

  async function handleTitleBlur() {
    await persistRecord(editorControllerRef.current?.getValue() ?? value, title, tagIds);
  }

  async function handleTagChange(nextTagIds: number[]) {
    setTagIds(nextTagIds);
    setShowTagEditor(nextTagIds.length > 0);
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

  function enterEditing(
    point?: RichEditorAutoFocusPoint,
    options: { autoFocusEditor?: boolean } = {},
  ) {
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
    if (editing) {
      await persistRecord(editorControllerRef.current?.getValue() ?? value, title, tagIds);
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
    void openFocusPage().finally(() => {
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
    const tag = await projectMindApi.fileTagOptionUpsert({
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

  function renderHeader() {
    return (
      <div className="project-history-record__header">
        <div className="project-history-record__header-main">
          {editing ? (
            <TextField
              value={title}
              placeholder="记录标题"
              className="project-history-record__title-input"
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => void handleTitleBlur()}
            />
          ) : (
            <p className="project-history-record__title">{titleDisplay}</p>
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
              <span>更新于 {formatDateTime(record.updatedAt)}</span>
            </div>
          )}
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
              void openFocusPage();
            }}
          >
            <ExternalLink size={15} />
          </IconButton>
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
            projectId={projectId}
            availableTags={availableTags}
            tags={selectedTags}
            busy={busy}
            inputRef={tagInputRef}
            onChange={(nextTagIds) => void handleTagChange(nextTagIds)}
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
        <div className="project-history-record__tag-list">
          {recordTags.map((tag) => (
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
        {renderTagRow()}
      </div>
    );
  }

  return (
    <article
      id={`record-${record.id}`}
      ref={containerRef}
      onMouseDownCapture={handleRecordMouseDownCapture}
      onDoubleClickCapture={handleRecordDoubleClickCapture}
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
          <div className="project-history-record__content">
            <RichEditor
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
            enterEditing();
          }}
        >
          {renderHeaderStack()}
          <CollapsibleRecordContent>
            <RichTextViewer html={renderableHtml} active={active} eagerManagedImages />
          </CollapsibleRecordContent>
        </div>
      )}
    </article>
  );
}

function CollapsibleRecordContent({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

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

  return (
    <div className="project-history-record__content">
      <div
        ref={contentRef}
        className={cn(
          "project-history-record__collapsible",
          canCollapse && !expanded && "project-history-record__collapsible--collapsed",
        )}
        style={
          canCollapse && !expanded
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
              setExpanded((current) => !current);
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
