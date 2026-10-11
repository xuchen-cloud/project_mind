import { HomeSaveIndicator } from "../home/HomeSaveIndicator";
import { HomeWorkspaceRail } from "../home/HomeWorkspaceRail";
import { HomeNoteSidebar } from "../home/HomeNoteSidebar";
import { HomeRecordHeader } from "../home/HomeRecordHeader";
import "../home/home.css";
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import { useNavigate,useParams,useSearchParams } from "react-router-dom";

import {
parseRouteId,
preserveRecordFilters,workspacePath
} from "../../lib/formatters";
import { colorKeyForTagLabel } from "../../lib/tags";
import { buildWorkspaceRecordRenameInput } from "../../lib/workspace-records";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useContactMentionNavigation } from "../../hooks/useContactMentionNavigation";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { useDelayedPending } from "../../hooks/useDelayedPending";
import { useScrollPositionRestoration } from "../../hooks/useUtilityHooks";
import { projectMindApi } from "../../services/projectMindApi";
import { queryKeys } from "../../lib/queryKeys";
import {
WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT,
type WorkspaceRecordFocusSaveRequestDetail,
} from "../../lib/record-focus-save";
import { workspaceRecordSaveKey } from "../../lib/record-save-coordinator";
import {
createRecordSaveCoordinator,
useRecordSaveCoordinator,
} from "../../lib/record-save-runtime";
import { DEFAULT_RICH_TEXT_STYLE_SETTINGS } from "../../lib/richTextStyle";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { Button,PageLoadingSkeleton,TextField } from "../../ui/components";
import {
normalizeRichEditorValue,
RichEditor,
type RichEditorController,
type RichEditorPersistState,
type RichEditorValue,
} from "../rich-editor";
import { buildWorkspaceNoteImageAssetHandlers } from "../rich-editor/noteImageAssets";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import { TodoModuleRail } from "../../todo";
import { RecordExportAction } from "../../features/record-export/RecordExportAction";
import type { RecordExportRequest } from "../../features/record-export/recordExport";
import { createDesktopRecordExporter } from "../../features/record-export/desktopRecordExportPlatform";
import type {
ProjectTagRecord,
RichTextStyleSettings,
WorkspacePageData,
} from "../../lib/types";
import {
recordFocusDraftFromRecord,
recordFocusDraftFromSnapshot,
} from "../record/recordFocusDraft";
import { RecordAiMetadataAction } from "../record/RecordAiMetadataAction";
import { VoiceRecordPanel } from "../voice/VoiceRecordPanel";

const EMPTY_VALUE: RichEditorValue = { html: "", text: "", markdown: "" };

export function WorkspaceRecordFocusPage({
  recordIdOverride,
  visible = true,
}: {
  recordIdOverride?: number;
  visible?: boolean;
} = {}) {
  const navigate = useNavigate();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const workspaceSaveCoordinator = useRecordSaveCoordinator();
  const recordId = recordIdOverride ?? parseRouteId(params.noteId);
  const latestSnapshot = recordId === null
    ? null
    : workspaceSaveCoordinator?.getLatestSnapshot(workspaceRecordSaveKey(recordId)) ?? null;
  const initialSnapshot = latestSnapshot?.scope === "workspace" ? latestSnapshot : null;
  const initialWorkspacePage = queryClient.getQueryData<WorkspacePageData>(
    queryKeys.workspacePage,
  );
  const initialRecord = initialWorkspacePage?.records?.find(
    (candidate) => candidate.id === recordId,
  );
  const initialDraft = initialSnapshot
    ? recordFocusDraftFromSnapshot(initialSnapshot)
    : initialRecord
      ? recordFocusDraftFromRecord(initialRecord)
      : null;
  const wasWorkspacePageCachedAtMount = useRef(
    initialWorkspacePage !== undefined,
  );
  const { scrollRef, hasSavedPosition } = useScrollPositionRestoration(
    `workspace-record:${recordId}`,
  );
  const { pushToast } = useFeedbackStore();
  const { openSettings } = useUiStore();
  const openInternalReference = useInternalReferenceNavigation();
  const openContactMention = useContactMentionNavigation();
  const contactMentionOptions = useContactMentionOptions();
  const workspaceAssetHandlers = useMemo(() => buildWorkspaceNoteImageAssetHandlers(), []);

  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [content, setContent] = useState<RichEditorValue>(initialDraft?.content ?? EMPTY_VALUE);
  const [tagIds, setTagIds] = useState<number[]>(initialDraft?.tagIds ?? []);
  const [codeLanguage, setCodeLanguage] = useState<string | null>(
    initialDraft?.codeLanguage ?? null,
  );
  const [loadedNoteId, setLoadedNoteId] = useState<number | null>(
    initialDraft ? recordId : null,
  );
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const editorControllerRef = useRef<RichEditorController | null>(null);
  const lastSavedUpdatedAtRef = useRef<string | null>(initialDraft?.updatedAt ?? null);
  const titleValueRef = useRef(initialDraft?.title ?? "");
  const tagIdsValueRef = useRef<number[]>(initialDraft?.tagIds ?? []);
  const codeLanguageValueRef = useRef<string | null>(initialDraft?.codeLanguage ?? null);

  const workspacePageQuery = useQuery({
    queryKey: queryKeys.workspacePage,
    queryFn: projectMindApi.workspacePageGet,
    enabled: visible && recordId !== null && loadedNoteId === null,
  });
  const workspaceStatusQuery = useQuery({
    queryKey: queryKeys.workspaceStatus,
    queryFn: projectMindApi.workspaceStatusGet,
    enabled: visible && recordId !== null,
  });

  const tagSettingsQuery = useQuery({
    queryKey: queryKeys.projectTags.workspace,
    queryFn: () => projectMindApi.projectTagSettingsGet({}),
    enabled: visible,
  });
  const aiSettingsQuery = useQuery({
    queryKey: queryKeys.aiSettings,
    queryFn: projectMindApi.aiSettingsGet,
    enabled: visible,
  });

  const note = useMemo(() => {
    if (!workspacePageQuery.data || recordId === null) return null;
    return (workspacePageQuery.data.records ?? []).find((record) => record.id === recordId) ?? null;
  }, [recordId, workspacePageQuery.data]);

  const availableTags = tagSettingsQuery.data?.tags ?? [];
  const aiSettings = aiSettingsQuery.data;
  const draftReady = recordId !== null && loadedNoteId === recordId;
  const currentWorkspace = workspaceStatusQuery.data?.currentWorkspace ?? null;
  const fallbackSaveCoordinator = useMemo(
    () => createRecordSaveCoordinator({
      workspaceKey: currentWorkspace?.rootPath ?? "workspace:unknown",
      queryClient,
    }),
    [currentWorkspace?.rootPath, queryClient],
  );
  const saveCoordinator = workspaceSaveCoordinator ?? fallbackSaveCoordinator;
  function syncWorkspaceTagCache(tag: ProjectTagRecord) {
    queryClient.setQueryData<{ tags: ProjectTagRecord[] } | undefined>(
      queryKeys.projectTags.workspace,
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

  useLayoutEffect(() => {
    if (!note || loadedNoteId === note.id) return;

    const draft = recordFocusDraftFromRecord(note);
    setTitle(draft.title);
    titleValueRef.current = draft.title;
    setContent(draft.content);
    setTagIds(draft.tagIds);
    tagIdsValueRef.current = draft.tagIds;
    setCodeLanguage(draft.codeLanguage);
    codeLanguageValueRef.current = draft.codeLanguage;
    setPersistState("idle");
    lastSavedUpdatedAtRef.current = note.updatedAt;
    setLoadedNoteId(note.id);
  }, [loadedNoteId, note]);

  const submitCurrentRecord = useCallback(
    (value?: RichEditorValue) => {
      if (!draftReady || recordId === null) return false;
      const committedContent =
        value ?? editorControllerRef.current?.getCommittedValue() ?? content;
      // Keep the controlled prop in lockstep with the exact snapshot sent to
      // the save coordinator.  The editor can start an AI session before the
      // query cache refreshes; leaving this prop at the mount-time HTML would
      // let controlled reconciliation reapply that stale document.
      setContent(committedContent);
      saveCoordinator.submit({
        scope: "workspace",
        workspaceKey:
          saveCoordinator.workspaceKey ?? currentWorkspace?.rootPath ?? "workspace:unknown",
        recordId,
        title: titleValueRef.current,
        tagIds: tagIdsValueRef.current,
        defaultCodeLanguage: codeLanguageValueRef.current,
        committedContent,
      });
      setPersistState("saving");
      return true;
    }, [content, currentWorkspace?.rootPath, draftReady, recordId, saveCoordinator],
  );

  useEffect(() => {
    if (recordId === null) return;
    return saveCoordinator.subscribe(() => {
      const status = saveCoordinator.getRecordStatus(workspaceRecordSaveKey(recordId));
      setPersistState(
        status.phase === "saving" ? "saving" : status.phase === "error" ? "error" : "saved",
      );
    });
  }, [recordId, saveCoordinator]);

  useEffect(() => {
    if (!visible) return;
    const handleRequest = (event: Event) => {
      const detail = (event as CustomEvent<WorkspaceRecordFocusSaveRequestDetail>).detail;
      if (!detail || detail.recordId !== recordId) return;
      detail.respond(draftReady ? submitCurrentRecord() : "not_needed");
    };
    window.addEventListener(WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleRequest);
    return () => window.removeEventListener(WORKSPACE_RECORD_FOCUS_SAVE_REQUEST_EVENT, handleRequest);
  }, [draftReady, recordId, submitCurrentRecord, visible]);

  const handleSave = useCallback(
    async (value: RichEditorValue) => {
      if (!submitCurrentRecord(value)) return false;
      try {
        await saveCoordinator.flush();
        await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
        return true;
      } catch (error) {
        pushToast({ tone: "error", title: "保存失败", detail: String(error) });
        throw error;
      }
    },
    [pushToast, queryClient, saveCoordinator, submitCurrentRecord],
  );

  const saveCurrentRecord = useCallback(async () => {
    if (!draftReady) return false;
    const editorController = editorControllerRef.current;
    if (editorController) {
      const request = editorController.save({ force: true });
      if (request) return (await request) !== false;
    }
    return handleSave(content);
  }, [content, draftReady, handleSave]);

  const runExport = useCallback((request: RecordExportRequest) => {
    const exportRecord = createDesktopRecordExporter(async () => {
      const saved = await saveCurrentRecord();
      if (!saved) throw new Error("导出前保存失败");
      const committed = editorControllerRef.current?.getCommittedValue?.() ?? normalizeRichEditorValue(content);
      return {
        recordKind: "workspace" as const,
        title,
        projectName: null,
        tags: availableTags.filter((tag) => tagIds.includes(tag.id)).map((tag) => tag.label),
        updatedAt: lastSavedUpdatedAtRef.current ?? note?.updatedAt,
        committedHtml: committed.html,
        style: queryClient.getQueryData<RichTextStyleSettings>(queryKeys.richTextStyle) ?? DEFAULT_RICH_TEXT_STYLE_SETTINGS,
      };
    });
    return exportRecord(request);
  }, [availableTags, content, note?.updatedAt, queryClient, saveCurrentRecord, tagIds, title]);

  const handleBack = () => {
    const target = draftReady
      ? `${workspacePath()}?view=record&focus=record-${recordId}`
      : `${workspacePath()}?view=record`;
    navigate(preserveRecordFilters(target, searchParams));
  };

  async function createWorkspaceRecordInFocus() {
    const record = await projectMindApi.workspaceRecordUpsert({
      markdown: "",
      html: "<p></p>",
      defaultCodeLanguage: null,
      tagIds: [],
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
    navigate(preserveRecordFilters(`/workspace/records/${record.id}`, searchParams));
  }

  async function renameWorkspaceSidebarRecord(nextRecordId: number, nextTitle: string) {
    if (nextRecordId === recordId) {
      const normalizedTitle = nextTitle.trim();
      setTitle(normalizedTitle);
      titleValueRef.current = normalizedTitle;
      await saveCurrentRecord();
      return;
    }

    const record = (workspacePageQuery.data?.records ?? []).find(
      (candidate) => candidate.id === nextRecordId,
    );
    if (!record) {
      return;
    }

    await projectMindApi.workspaceRecordUpsert(
      buildWorkspaceRecordRenameInput(record, nextTitle),
    );
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
  }

  async function deleteWorkspaceSidebarRecord(nextRecordId: number) {
    if (nextRecordId === recordId) {
      const saved = await saveCurrentRecord();
      if (!saved) {
        return;
      }
    }

    await projectMindApi.workspaceRecordDelete({ noteId: nextRecordId });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
    await queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });

    if (nextRecordId === recordId) {
      navigate(preserveRecordFilters(`${workspacePath()}?view=record`, searchParams));
    }
  }

  const handleTagsChange = async (newTagIds: number[]) => {
    if (!draftReady) return;
    setTagIds(newTagIds);
    tagIdsValueRef.current = newTagIds;
    try {
      const nextValue = editorControllerRef.current?.getValue() ?? content;
      await handleSave(nextValue);
    } catch (error) {
      pushToast({ tone: "error", title: "标签更新失败", detail: String(error) });
    }
  };

  const showRecordSkeleton = useDelayedPending(!draftReady);

  if (recordId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-text-soft">无效的记录ID</p>
        <Button onClick={handleBack}>返回工作区</Button>
      </div>
    );
  }

  if (
    !draftReady &&
    (workspacePageQuery.isFetching || workspaceStatusQuery.isLoading)
  ) {
    if (!showRecordSkeleton) return null;
    return <PageLoadingSkeleton variant="record" label="正在加载工作区记录" />;
  }

  if (!draftReady && !note) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-text-soft">{workspacePageQuery.isError ? "记录加载失败，请重试" : "记录未找到"}</p>
        <div className="flex items-center gap-2">
          <Button onClick={handleBack}>返回工作区</Button>
          {workspacePageQuery.isError ? (
            <Button onClick={() => void workspacePageQuery.refetch()}>重试</Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!draftReady) {
    if (!showRecordSkeleton) return null;
    return <PageLoadingSkeleton variant="record" label="正在加载工作区记录" />;
  }

  return (
    <div
      className="home-page home-note-page page-cold-entry relative flex h-full min-h-0 overflow-hidden"
      data-focus-page-key={`workspace:${recordId}`}
      data-cold-entry={wasWorkspacePageCachedAtMount.current ? undefined : "true"}
    >
      {currentWorkspace ? (
        <HomeNoteSidebar workspaceRoot={currentWorkspace.rootPath}
          onRenameRecord={renameWorkspaceSidebarRecord} onDeleteRecord={deleteWorkspaceSidebarRecord}
          records={workspacePageQuery.data?.records ?? []} activeRecordId={recordId}
          onOpenWorkspace={handleBack} onOpenRecord={(id) => navigate(preserveRecordFilters(`/workspace/records/${id}`, searchParams))}
          onCreateRecord={() => void createWorkspaceRecordInFocus()} />
      ) : null}

      <div className="project-overview-focus flex-1">


        <div ref={scrollRef} className="project-overview-focus__scroll">
          <div className="home-content home-note-content">
            <div className="grid gap-4">
              <HomeRecordHeader onOpenHome={handleBack} identityKey={`workspace:${currentWorkspace?.rootPath}`} scopeName={currentWorkspace?.displayName || "我的工作区"} title={title}>
              <div className="flex min-w-0 items-center gap-2">
                <TextField
                  value={title}
                  placeholder="记录标题"
                  onChange={(event) => {
                    setTitle(event.target.value);
                    titleValueRef.current = event.target.value;
                  }}
                  onBlur={() => {
                    if (draftReady && title !== (note?.title ?? initialDraft?.title ?? "")) {
                      void handleSave(editorControllerRef.current?.getValue() ?? content);
                    }
                  }}
                  className="min-w-0 flex-1 text-lg font-medium"
                />
                <RecordAiMetadataAction
                  target={{ scope: "workspace", recordId }}
                  aiSettings={aiSettings}
                  availableTags={availableTags}
                  currentTagIds={tagIds}
                  getCommittedMarkdown={() =>
                    editorControllerRef.current?.getCommittedValue().markdown ??
                    normalizeRichEditorValue(content).markdown
                  }
                  beforeApply={async () => {
                    if (!(await saveCurrentRecord())) {
                      throw new Error("应用标题和标签前保存正文失败");
                    }
                  }}
                  onApplied={(value) => {
                    setTitle(value.title);
                    titleValueRef.current = value.title;
                    const nextTagIds = value.tags.map((tag) => tag.id);
                    setTagIds(nextTagIds);
                    tagIdsValueRef.current = nextTagIds;
                    void queryClient.invalidateQueries({ queryKey: queryKeys.workspacePage });
                    void queryClient.invalidateQueries({ queryKey: queryKeys.projectTags.workspace });
                  }}
                  onOpenAiSettings={() => openSettings("ai-rewrite")}
                />
              <RecordExportAction
                title={title}
                getCommittedHtml={() => editorControllerRef.current?.getCommittedValue?.().html ?? content.html}
                exportTo={runExport}
              />
              <HomeSaveIndicator state={persistState} />
              </div>
              </HomeRecordHeader>
              <EntityTagEditor inputPlaceholder="新增标签"
                projectId={null}
                availableTags={availableTags}
                tags={availableTags.filter((tag) => tagIds.includes(tag.id))}
                onChange={handleTagsChange}
                onCreated={syncWorkspaceTagCache}
              />
              {note?.isVoice && recordId !== null ? (
                <VoiceRecordPanel
                  target={{ scope: "workspace", recordId }}
                  visible={visible}
                  onTitleUpdated={(nextTitle) => {
                    setTitle(nextTitle);
                    titleValueRef.current = nextTitle;
                  }}
                  onCopyMinutes={async (minutes) => {
                    const next = editorControllerRef.current?.appendMarkdown(minutes);
                    if (!next || !submitCurrentRecord(next)) throw new Error("未能写入正文");
                    setContent(next);
                    await saveCoordinator.flush();
                  }}
                />
              ) : null}
              <RichEditor
                key={recordId}
                contentIdentity={`workspace-record:${recordId}`}
                html={content.html}
                aiSettings={aiSettings}
                defaultCodeLanguage={codeLanguage}
                onDefaultCodeLanguageChange={(value) => {
                  setCodeLanguage(value);
                  codeLanguageValueRef.current = value;
                }}
                variant="page"
                showToolbar={false}
                autoFocus={visible && !hasSavedPosition}
                readOnly={!visible}
                assetHandlers={workspaceAssetHandlers}
                placeholder="写记录，正文里的 #标签 会自动同步。"
                tagMentions={{
                  projectId: null,
                  availableTags,
                  onCreateTag: async (label) => {
                    const tag = await projectMindApi.projectTagUpsert({
                      label,
                      colorKey: colorKeyForTagLabel(label),
                    });
                    syncWorkspaceTagCache(tag);
                    return tag;
                  },
                }}
                internalReferences={{
                  context: { scope: "workspace" },
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
      </div>

      {workspacePageQuery.data ? (
        <HomeWorkspaceRail>
        <TodoModuleRail
          scope={{ kind: "workspace" }}
          enabled={visible}
          availableTags={availableTags}
          onOpenInternalReference={openInternalReference}
          onOpenContactMention={openContactMention}
        />
        </HomeWorkspaceRail>
      ) : null}
    </div>
  );
}
