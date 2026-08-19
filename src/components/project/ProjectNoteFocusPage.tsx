import { ArrowLeft, FileDown, LoaderCircle, MoreHorizontal, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { parseRouteId, preserveRecordFilters, projectPath } from "../../lib/formatters";
import { withPageWidthClass } from "../../lib/pageWidth";
import {
  PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT,
  type ProjectRecordFocusSaveRequestDetail,
} from "../../lib/record-focus-save";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useScrollPositionRestoration } from "../../hooks/useUtilityHooks";
import { colorKeyForTagLabel } from "../../lib/tags";
import { extractTagMentionIds } from "../../lib/tagMentions";
import { projectMindApi } from "../../services/projectMindApi";
import { desktopApi } from "../../services/desktopApi";
import { queryKeys } from "../../lib/queryKeys";
import { DEFAULT_RICH_TEXT_STYLE_SETTINGS } from "../../lib/richTextStyle";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { ActionContextMenu, Button, IconButton, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import {
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorAssetHandlers,
  type RichEditorController,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";
import {
  buildProjectNoteImageAssetHandlers,
  externalizeEmbeddedImageDataUrls,
} from "../rich-editor/noteImageAssets";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import { RecordExportDialog } from "../../features/record-export/RecordExportDialog";
import { createRecordExportCoordinator, type RecordExportRequest } from "../../features/record-export/recordExport";
import { createDesktopRecordExportPlatform } from "../../features/record-export/desktopRecordExportPlatform";
import { chooseRecordExportTarget } from "../../features/record-export/recordExportTarget";
import type { ProjectPageData, ProjectTagRecord, NoteRecord } from "../../lib/types";
import type { RichTextStyleSettings } from "../../lib/types";

export function ProjectNoteFocusPage() {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const projectId = parseRouteId(params.projectId);
  const noteId = parseRouteId(params.noteId);
  const focusScrollRef = useRef<HTMLDivElement | null>(null);
  const { pushToast } = useFeedbackStore();
  const { openSettings, pageWidthMode, projectSidebarCollapsed } = useUiStore();
  const navigateInternalReference = useInternalReferenceNavigation();
  const contactMentionOptions = useContactMentionOptions();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState<RichEditorValue>({ html: "", text: "", markdown: "" });
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [codeLanguage, setCodeLanguage] = useState<string | null>(null);
  const [loadedNoteId, setLoadedNoteId] = useState<number | null>(null);
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [exportOpen, setExportOpen] = useState(false);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const editorControllerRef = useRef<RichEditorController | null>(null);
  const lastSavedTitleRef = useRef("");
  const titleValueRef = useRef("");
  const tagIdsValueRef = useRef<number[]>([]);
  const codeLanguageValueRef = useRef<string | null>(null);
  const pendingPersistRef = useRef<Promise<boolean> | null>(null);
  const lastSavedUpdatedAtRef = useRef<string | null>(null);

  const projectQuery = useQuery({
    queryKey: queryKeys.projects.all,
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: projectId !== null,
  });

  const projectPageQuery = useQuery({
    queryKey: queryKeys.projectPage(projectId),
    queryFn: () => projectMindApi.projectPageGet({ projectId: projectId as number }),
    enabled: projectId !== null && noteId !== null,
  });

  const tagSettingsQuery = useQuery({
    queryKey: queryKeys.projectTags.project(projectId),
    queryFn: () => projectMindApi.projectTagSettingsGet({ projectId: projectId as number }),
    enabled: projectId !== null,
  });
  const aiSettingsQuery = useQuery({
    queryKey: queryKeys.aiSettings,
    queryFn: projectMindApi.aiSettingsGet,
  });

  const project =
    projectId === null
      ? null
      : (projectQuery.data ?? []).find((item) => item.id === projectId) ?? null;
  const { scrollRef, hasSavedPosition } = useScrollPositionRestoration(
    `project-record:${project?.rootPath ?? `project-${projectId}`}:${noteId}`,
  );
  const setFocusScrollRef = useCallback(
    (element: HTMLDivElement | null) => {
      focusScrollRef.current = element;
      scrollRef(element);
    },
    [scrollRef],
  );

  const note = useMemo(() => {
    if (!projectPageQuery.data || noteId === null) return null;
    return (projectPageQuery.data.records ?? []).find((record) => record.id === noteId) ?? null;
  }, [projectPageQuery.data, noteId]);

  const availableTags = tagSettingsQuery.data?.tags ?? [];
  const aiSettings = aiSettingsQuery.data ?? null;
  const draftReady = Boolean(note && loadedNoteId === note.id);
  const assetHandlers = useMemo<RichEditorAssetHandlers | undefined>(() => {
    if (!projectId || !note) {
      return undefined;
    }

    return buildProjectNoteImageAssetHandlers(projectId, note.activityId ?? null);
  }, [note, projectId]);

  function syncProjectTagCache(tag: ProjectTagRecord) {
    queryClient.setQueryData<{ tags: ProjectTagRecord[] } | undefined>(
      queryKeys.projectTags.project(projectId),
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

  // Initialize state from note
  useEffect(() => {
    if (!note || loadedNoteId === note.id) return;

    setTitle(note.title ?? "");
    titleValueRef.current = note.title ?? "";
    lastSavedTitleRef.current = note.title ?? "";
    setContent({
      html: getRenderableRichTextHtml({ html: note.contentHtml, markdown: note.contentMarkdown }),
      text: note.contentMarkdown,
      markdown: note.contentMarkdown,
    });
    const nextTagIds = (note.tags ?? []).map((tag) => tag.id);
    setTagIds(nextTagIds);
    tagIdsValueRef.current = nextTagIds;
    setCodeLanguage(note.defaultCodeLanguage ?? null);
    codeLanguageValueRef.current = note.defaultCodeLanguage ?? null;
    setPersistState("idle");
    lastSavedUpdatedAtRef.current = note.updatedAt;
    setLoadedNoteId(note.id);
  }, [loadedNoteId, note]);

  const persistProjectRecord = useCallback(
    async (
      targetNote: NoteRecord,
      value: RichEditorValue,
      nextTitle: string,
      nextTagIds: number[],
      nextCodeLanguage: string | null,
    ) => {
      if (!projectId) return false;

      const operation = (async () => {
        try {
          const targetAssetHandlers = buildProjectNoteImageAssetHandlers(
            targetNote.projectId,
            targetNote.activityId ?? null,
          );
          const externalizedValue = await externalizeEmbeddedImageDataUrls(
            value,
            targetAssetHandlers,
          );
          const normalized = normalizeRichEditorValue(externalizedValue);
          const mentionedTagIds = extractTagMentionIds(normalized.markdown);
          const savedRecord = await projectMindApi.projectRecordUpsert({
            projectId: targetNote.projectId,
            activityId: targetNote.activityId ?? undefined,
            noteId: targetNote.id,
            title: nextTitle.trim() || undefined,
            markdown: normalized.markdown,
            html: normalized.html,
            defaultCodeLanguage: nextCodeLanguage,
            tagIds: Array.from(new Set([...nextTagIds, ...mentionedTagIds])),
          });
          queryClient.setQueryData<ProjectPageData | undefined>(
            queryKeys.projectPage(projectId),
            (current) =>
              current
                ? {
                    ...current,
                    records: (current.records ?? []).map((record) =>
                      record.id === savedRecord.id ? savedRecord : record,
                    ),
                  }
                : current,
          );
          lastSavedTitleRef.current = nextTitle;
          lastSavedUpdatedAtRef.current = savedRecord.updatedAt;
          return true;
        } catch (error) {
          pushToast({ tone: "error", title: "保存失败", detail: String(error) });
          throw error;
        }
      })();

      pendingPersistRef.current = operation;
      void operation.then(
        () => {
          if (pendingPersistRef.current === operation) pendingPersistRef.current = null;
        },
        () => {
          if (pendingPersistRef.current === operation) pendingPersistRef.current = null;
        },
      );
      return operation;
    },
    [projectId, pushToast, queryClient],
  );

  const handleSave = useCallback(
    async (value: RichEditorValue) => {
      if (!note || !draftReady) return false;
      return persistProjectRecord(
        note,
        value,
        titleValueRef.current,
        tagIdsValueRef.current,
        codeLanguageValueRef.current,
      );
    },
    [draftReady, note, persistProjectRecord],
  );

  const saveCurrentRecord = useCallback(async () => {
    if (!note || !draftReady) return false;
    const scrollElement = focusScrollRef.current;
    const scrollTop = scrollElement?.scrollTop ?? null;
    const editorController = editorControllerRef.current;
    let saved: unknown;
    if (editorController) {
      const saveRequest = editorController.save({ force: true });
      if (saveRequest) {
        saved = await saveRequest;
      } else if (pendingPersistRef.current) {
        saved = await pendingPersistRef.current;
      } else {
        saved = true;
      }
    } else {
      saved = await persistProjectRecord(
        note,
        content,
        titleValueRef.current,
        tagIdsValueRef.current,
        codeLanguageValueRef.current,
      );
    }
    if (scrollElement && scrollTop !== null) {
      scrollElement.scrollTop = scrollTop;
    }
    return saved !== false;
  }, [content, draftReady, note, persistProjectRecord]);

  useEffect(() => {
    const handleSaveRequest = (event: Event) => {
      const detail = (event as CustomEvent<ProjectRecordFocusSaveRequestDetail>).detail;
      if (!detail || detail.projectId !== projectId || detail.noteId !== noteId) {
        return;
      }

      detail.respond(saveCurrentRecord());
    };

    window.addEventListener(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleSaveRequest);
    return () => {
      window.removeEventListener(PROJECT_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleSaveRequest);
    };
  }, [noteId, projectId, saveCurrentRecord]);

  const saveTitleIfChanged = async () => {
    if (!note || !draftReady || titleValueRef.current === lastSavedTitleRef.current) {
      return;
    }

    await saveCurrentRecord();
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || (event.key !== "Tab" && event.key !== "Enter")) {
      return;
    }

    event.preventDefault();
    void saveTitleIfChanged()
      .then(() => {
        tagInputRef.current?.focus();
      })
      .catch(() => undefined);
  };

  const handleBack = async () => {
    if (projectId !== null) {
      // Save before navigating back
      await saveCurrentRecord();
      navigate(
        preserveRecordFilters(projectPath(projectId, `record-${noteId}`), searchParams),
      );
    }
  };

  const handleTagsChange = async (newTagIds: number[]) => {
    if (!note || !draftReady) return;
    setTagIds(newTagIds);
    tagIdsValueRef.current = newTagIds;
    try {
      await saveCurrentRecord();
    } catch (error) {
      pushToast({ tone: "error", title: "标签更新失败", detail: String(error) });
    }
  };

  const openInternalReference = useCallback(
    async (reference: Parameters<typeof navigateInternalReference>[0]) => {
      try {
        const saved = await saveCurrentRecord();
        if (!saved) return false;
      } catch {
        return false;
      }
      return navigateInternalReference(reference);
    },
    [navigateInternalReference, saveCurrentRecord],
  );

  const runExport = useCallback((request: RecordExportRequest) => {
    const platform = createDesktopRecordExportPlatform(async () => {
      const saved = await saveCurrentRecord();
      if (!saved) throw new Error("导出前保存失败");
      const committed = editorControllerRef.current?.getCommittedValue?.() ?? normalizeRichEditorValue(content);
      return {
        recordKind: "project" as const,
        title: titleValueRef.current,
        projectName: project?.name,
        tags: availableTags.filter((tag) => tagIdsValueRef.current.includes(tag.id)).map((tag) => tag.label),
        updatedAt: lastSavedUpdatedAtRef.current ?? note?.updatedAt,
        committedHtml: committed.html,
        style: queryClient.getQueryData<RichTextStyleSettings>(queryKeys.richTextStyle) ?? DEFAULT_RICH_TEXT_STYLE_SETTINGS,
      };
    });
    return createRecordExportCoordinator(platform).export(request);
  }, [availableTags, content, note?.updatedAt, project?.name, queryClient, saveCurrentRecord]);

  if (projectId === null || noteId === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-text-soft">无效的记录ID</p>
      </div>
    );
  }

  if (projectQuery.isLoading || projectPageQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="animate-spin text-text-soft" size={24} />
      </div>
    );
  }

  if (!project || !note) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-text-soft">记录未找到</p>
      </div>
    );
  }

  if (!draftReady) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoaderCircle className="animate-spin text-text-soft" size={24} />
      </div>
    );
  }

  return (
    <div
      className="project-overview-focus h-full min-h-0"
      data-focus-page-key={`${projectId}:${noteId}`}
    >
      {/* Header */}
      <header className="project-overview-focus__chrome">
        <div
          className={cn(
            "project-overview-focus__chrome-inner",
            projectSidebarCollapsed && "project-overview-focus__chrome-inner--dock-left",
          )}
        >
          <div className="project-overview-focus__meta">
            <div className="flex items-center gap-3">
              <IconButton
                type="button"
                size="sm"
                variant="ghost"
                aria-label="返回项目"
                onClick={handleBack}
              >
                <ArrowLeft size={16} />
              </IconButton>
              <div>
                <p className="text-caption text-text-soft">{project.name}</p>
                <p className="text-ui font-medium text-text">记录</p>
              </div>
            </div>
          </div>

          <div className="project-overview-focus__header-actions">
            <Button type="button" size="sm" variant="ghost" onClick={() => openSettings("page-width")}>
              页面宽度
            </Button>
            <IconButton type="button" size="sm" variant="ghost" aria-label="记录更多操作"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMoreMenu({ x: rect.right, y: rect.bottom + 4 });
              }}>
              <MoreHorizontal size={16} />
            </IconButton>
            <span
              className={cn(
                "text-caption",
                persistState === "saving"
                  ? "text-text-soft"
                  : persistState === "saved"
                    ? "text-green-600"
                    : persistState === "error"
                      ? "text-red-600"
                      : "text-text-soft"
              )}
            >
              {persistState === "saving"
                ? "保存中..."
                : persistState === "saved"
                  ? "已保存"
                  : persistState === "error"
                    ? "保存失败"
                    : ""}
            </span>
          </div>
        </div>
      </header>

      {/* Content */}
      <div
        ref={setFocusScrollRef}
        className="project-overview-focus__scroll"
        data-testid="project-record-focus-scroll"
      >
        <div
          className={withPageWidthClass(
            "mx-auto w-full px-6 py-6",
            pageWidthMode,
            "focus",
          )}
        >
          <div className="grid gap-4">
            <TextField
              ref={titleInputRef}
              value={title}
              placeholder="记录标题"
              onChange={(event) => {
                setTitle(event.target.value);
                titleValueRef.current = event.target.value;
              }}
              onBlur={() => void saveTitleIfChanged().catch(() => undefined)}
              onKeyDown={handleTitleKeyDown}
              className="text-lg font-medium"
            />
            <EntityTagEditor
              projectId={project.id}
              availableTags={availableTags}
              tags={availableTags.filter((tag) => tagIds.includes(tag.id))}
              inputRef={tagInputRef}
              onChange={handleTagsChange}
              onCreated={() => tagSettingsQuery.refetch()}
              onCommitNavigation={(reason) => {
                if (reason === "enter") {
                  editorControllerRef.current?.focus("end");
                }
              }}
            />
            <RichEditor
              key={`${project.id}:${note.id}`}
              html={content.html}
              aiSettings={aiSettings}
              defaultCodeLanguage={codeLanguage}
              onDefaultCodeLanguageChange={(language) => {
                setCodeLanguage(language);
                codeLanguageValueRef.current = language;
              }}
              variant="page"
              showToolbar={false}
              autoFocus={!hasSavedPosition}
              placeholder="写记录，正文里的 #标签 会自动同步。"
              assetHandlers={assetHandlers}
              tagMentions={{
                projectId: project.id,
                availableTags,
                onCreateTag: async (label) => {
                  const tag = await projectMindApi.projectTagUpsert({
                    projectId: project.id,
                    label,
                    colorKey: colorKeyForTagLabel(label),
                  });
                  syncProjectTagCache(tag);
                  return tag;
                },
              }}
              internalReferences={{
                context: { scope: "project", projectId: project.id },
                onOpenReference: openInternalReference,
              }}
              contactMentions={contactMentionOptions}
              autosave={{
                delay: 120000,
                onBlur: true,
                onWindowBlur: true,
                onVisibilityChange: true,
              }}
              controllerRef={editorControllerRef}
              onOpenAiSettings={() => openSettings("ai-rewrite")}
              onSave={handleSave}
              onPersistStateChange={setPersistState}
            />
          </div>
        </div>
      </div>
      {moreMenu ? (
        <ActionContextMenu x={moreMenu.x} y={moreMenu.y} ariaLabel="记录更多操作" onClose={() => setMoreMenu(null)}
          actions={[{ label: "导出…", icon: FileDown, onSelect: () => { setMoreMenu(null); setExportOpen(true); } }]} />
      ) : null}
      <RecordExportDialog
        open={exportOpen}
        hasImages={/<img\b/iu.test(editorControllerRef.current?.getCommittedValue?.().html ?? content.html)}
        onClose={() => setExportOpen(false)}
        chooseTarget={(format, includeImages) => chooseRecordExportTarget({ title: titleValueRef.current, format, includeImages, hasImages: /<img\b/iu.test(editorControllerRef.current?.getCommittedValue?.().html ?? content.html) })}
        exportTo={runExport}
        onOpenFile={(path) => desktopApi.openFile(path)}
        onRevealFile={(path) => desktopApi.revealPath(path)}
      />
    </div>
  );
}
