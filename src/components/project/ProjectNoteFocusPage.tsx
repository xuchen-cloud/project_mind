import { ArrowLeft, LoaderCircle, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";

import { parseRouteId, projectPath } from "../../lib/formatters";
import { noteTemplateLabel } from "../../lib/note-templates";
import { useContactMentionOptions } from "../../hooks/useContactMentionOptions";
import { useInternalReferenceNavigation } from "../../hooks/useInternalReferenceNavigation";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { Button, IconButton, TextField } from "../../ui/components";
import { cn } from "../../ui/lib/cn";
import {
  getRenderableRichTextHtml,
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorPersistState,
  type RichEditorValue,
} from "../rich-editor";
import { EntityTagEditor } from "../tags/EntityTagEditor";
import type { FileTagRecord, NoteRecord } from "../../lib/types";

export function ProjectNoteFocusPage() {
  const navigate = useNavigate();
  const params = useParams();
  const queryClient = useQueryClient();
  const projectId = parseRouteId(params.projectId);
  const noteId = parseRouteId(params.noteId);
  const { pushToast } = useFeedbackStore();
  const openInternalReference = useInternalReferenceNavigation();
  const contactMentionOptions = useContactMentionOptions();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState<RichEditorValue>({ html: "", text: "", markdown: "" });
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [persistState, setPersistState] = useState<RichEditorPersistState>("idle");
  const [isSaving, setIsSaving] = useState(false);

  const projectQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
    enabled: projectId !== null,
  });

  const overviewQuery = useQuery({
    queryKey: ["overview", projectId],
    queryFn: () => projectMindApi.projectGetOverview({ projectId: projectId as number }),
    enabled: projectId !== null && noteId !== null,
  });

  const tagSettingsQuery = useQuery({
    queryKey: ["file-tag-settings", projectId],
    queryFn: projectMindApi.fileTagSettingsGet,
    enabled: projectId !== null,
  });

  const recordTypeSettingsQuery = useQuery({
    queryKey: ["record-type-settings"],
    queryFn: projectMindApi.recordTypeSettingsGet,
  });

  const project =
    projectId === null
      ? null
      : (projectQuery.data ?? []).find((item) => item.id === projectId) ?? null;

  const note = useMemo(() => {
    if (!overviewQuery.data || noteId === null) return null;
    return (overviewQuery.data.records ?? []).find((record) => record.id === noteId) ?? null;
  }, [overviewQuery.data, noteId]);

  const availableTags = tagSettingsQuery.data?.tags ?? [];

  // Initialize state from note
  useEffect(() => {
    if (note) {
      setTitle(note.title ?? "");
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
      const normalized = normalizeRichEditorValue(value);
      await projectMindApi.noteUpsert({
        projectId: note.projectId,
        noteId: note.id,
        noteType: note.noteType,
        title: title.trim() || undefined,
        markdown: normalized.markdown,
        html: normalized.html,
        tagIds,
      });
      await overviewQuery.refetch();
      // Invalidate the overview query in other components
      await queryClient.invalidateQueries({ queryKey: ["overview", projectId] });
    } catch (error) {
      pushToast({ tone: "error", title: "保存失败", detail: String(error) });
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const handleBack = async () => {
    if (projectId !== null) {
      // Save before navigating back
      await handleSave(content);
      navigate(projectPath(projectId, `record-${noteId}`));
    }
  };

  const handleTagsChange = async (newTagIds: number[]) => {
    if (!note) return;
    setTagIds(newTagIds);
    try {
      await projectMindApi.noteUpsert({
        projectId: note.projectId,
        noteId: note.id,
        noteType: note.noteType,
        markdown: content.markdown,
        html: content.html,
        tagIds: newTagIds,
      });
      await overviewQuery.refetch();
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

  if (projectQuery.isLoading || overviewQuery.isLoading) {
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

  const recordTypeLabel = noteTemplateLabel(note.noteType, recordTypeSettingsQuery.data);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      {/* Header */}
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-bg px-6 py-3">
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
            <p className="text-ui font-medium text-text">{recordTypeLabel}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
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
      </header>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[min(56rem,calc(100vw-4rem))] px-6 py-6">
          <div className="grid gap-4">
            <TextField
              value={title}
              placeholder="记录标题"
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                // Save title changes
                if (note && title !== (note.title ?? "")) {
                  handleSave(content);
                }
              }}
              className="text-lg font-medium"
            />
            <EntityTagEditor
              projectId={project.id}
              availableTags={availableTags}
              tags={availableTags.filter((tag) => tagIds.includes(tag.id))}
              onChange={handleTagsChange}
              onCreated={() => tagSettingsQuery.refetch()}
            />
            <RichEditor
              html={content.html}
              variant="bare"
              autoFocus
              placeholder="写记录，正文里的 #标签 会自动同步。"
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
              onChange={setContent}
              onSave={handleSave}
              onPersistStateChange={setPersistState}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
