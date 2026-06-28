import { ArrowLeft, LoaderCircle, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";

import { parseRouteId, projectPath } from "../../lib/formatters";
import { withPageWidthClass } from "../../lib/pageWidth";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { colorKeyForTagLabel } from "../../lib/tags";
import { extractTagMentionIds } from "../../lib/tagMentions";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { useUiStore } from "../../state/ui-store";
import { Button, IconButton, TextField } from "../../ui/components";
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
import type { FileTagRecord, NoteRecord } from "../../lib/types";

export function ProjectNoteFocusPage() {
  const navigate = useNavigate();
  const params = useParams();
  const queryClient = useQueryClient();
  const projectId = parseRouteId(params.projectId);
  const noteId = parseRouteId(params.noteId);
  const { pushToast } = useFeedbackStore();
  const { openSettings, pageWidthMode, projectSidebarCollapsed } = useUiStore();
  const openInternalReference = useInternalReferenceNavigation();
  const contactMentionOptions = useContactMentionOptions();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState<RichEditorValue>({ html: "", text: "", markdown: "" });
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [isSaving, setIsSaving] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);
  const editorControllerRef = useRef<RichEditorController | null>(null);
  const lastSavedTitleRef = useRef("");

  const projectQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: projectId !== null,
  });

  const projectPageQuery = useQuery({
    queryKey: ["project-page", projectId],
    queryFn: () => projectMindApi.projectPageGet({ projectId: projectId as number }),
    enabled: projectId !== null && noteId !== null,
  });

  const tagSettingsQuery = useQuery({
    queryKey: ["file-tag-settings", projectId],
    queryFn: () => projectMindApi.fileTagSettingsGet({ projectId: projectId as number }),
    enabled: projectId !== null,
  });

  const project =
    projectId === null
      ? null
      : (projectQuery.data ?? []).find((item) => item.id === projectId) ?? null;

  const note = useMemo(() => {
    if (!projectPageQuery.data || noteId === null) return null;
    return (projectPageQuery.data.records ?? []).find((record) => record.id === noteId) ?? null;
  }, [projectPageQuery.data, noteId]);

  const availableTags = tagSettingsQuery.data?.tags ?? [];
  const assetHandlers = useMemo<RichEditorAssetHandlers | undefined>(() => {
    if (!projectId || !note) {
      return undefined;
    }

    return buildProjectNoteImageAssetHandlers(projectId, note.activityId ?? null);
  }, [note, projectId]);

  function syncProjectTagCache(tag: FileTagRecord) {
    queryClient.setQueryData<{ tags: FileTagRecord[] } | undefined>(
      ["file-tag-settings", projectId],
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
    if (note) {
      setTitle(note.title ?? "");
      lastSavedTitleRef.current = note.title ?? "";
      setContent({
        html: getRenderableRichTextHtml({ html: note.contentHtml, markdown: note.contentMarkdown }),
        text: note.contentMarkdown,
        markdown: note.contentMarkdown,
      });
      setTagIds((note.tags ?? []).map((tag) => tag.id));
    }
  }, [note]);

  const handleSave = async (value: RichEditorValue) => {
    if (!note || isSaving || !projectId) return;

    setIsSaving(true);
    try {
      const externalizedValue = await externalizeEmbeddedImageDataUrls(value, assetHandlers);
      const normalized = normalizeRichEditorValue(externalizedValue);
      const mentionedTagIds = extractTagMentionIds(normalized.markdown);
      await projectMindApi.projectRecordUpsert({
        projectId: note.projectId,
        activityId: note.activityId ?? undefined,
        noteId: note.id,
        title: title.trim() || undefined,
        markdown: normalized.markdown,
        html: normalized.html,
        tagIds: Array.from(new Set([...tagIds, ...mentionedTagIds])),
      });
      await projectPageQuery.refetch();
      await queryClient.invalidateQueries({ queryKey: ["project-page", projectId] });
      lastSavedTitleRef.current = title;
    } catch (error) {
      pushToast({ tone: "error", title: "保存失败", detail: String(error) });
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const saveTitleIfChanged = async () => {
    if (!note || title === lastSavedTitleRef.current) {
      return;
    }

    await handleSave(editorControllerRef.current?.getValue() ?? content);
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
      await handleSave(editorControllerRef.current?.getValue() ?? content);
      navigate(projectPath(projectId, `record-${noteId}`));
    }
  };

  const handleTagsChange = async (newTagIds: number[]) => {
    if (!note) return;
    setTagIds(newTagIds);
    try {
      const nextValue = editorControllerRef.current?.getValue() ?? content;
      const externalizedValue = await externalizeEmbeddedImageDataUrls(nextValue, assetHandlers);
      const normalized = normalizeRichEditorValue(externalizedValue);
      await projectMindApi.projectRecordUpsert({
        projectId: note.projectId,
        activityId: note.activityId ?? undefined,
        noteId: note.id,
        title: title.trim() || undefined,
        markdown: normalized.markdown,
        html: normalized.html,
        tagIds: newTagIds,
      });
      lastSavedTitleRef.current = title;
      await projectPageQuery.refetch();
    } catch (error) {
      pushToast({ tone: "error", title: "标签更新失败", detail: String(error) });
    }
  };

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
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
      <div className="min-h-0 flex-1 overflow-y-auto">
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
              onChange={(event) => setTitle(event.target.value)}
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
              html={content.html}
              variant="bare"
              autoFocus
              placeholder="写记录，正文里的 #标签 会自动同步。"
              assetHandlers={assetHandlers}
              tagMentions={{
                projectId: project.id,
                availableTags,
                onCreateTag: async (label) => {
                  const tag = await projectMindApi.fileTagOptionUpsert({
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
              onSave={handleSave}
              onPersistStateChange={setPersistState}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
