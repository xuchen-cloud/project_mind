import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Save, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { withPageWidthClass } from "../../lib/pageWidth";
import { colorKeyForTagLabel } from "../../lib/tags";
import { projectMindApi } from "../../services/projectMindApi";
import type {
  AiSettingsSnapshot,
  FileTagRecord,
  WorkspaceRecord,
} from "../../lib/types";
import { useUiStore, type PageWidthMode } from "../../state/ui-store";
import { ActionContextMenu, Button, EmptyState, TextField } from "../../ui/components";
import { RecordListItem } from "../record/RecordListItem";
import {
  normalizeRichEditorValue,
  RichEditor,
  type RichEditorAssetHandlers,
  type RichEditorController,
  type RichEditorContactMentionOptions,
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
  aiSettings: AiSettingsSnapshot | null;
  saving?: boolean;
  onCreateRecord: (input: {
    title?: string;
    markdown: string;
    html: string;
    defaultCodeLanguage?: string | null;
    tagIds?: number[];
  }) => Promise<unknown>;
  onUpdateRecord: (
    note: WorkspaceRecord,
    input: {
      title?: string;
      markdown: string;
      html: string;
      defaultCodeLanguage?: string | null;
      tagIds?: number[];
    },
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
  aiSettings,
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const openSettings = useUiStore((state) => state.openSettings);
  const [recordDraftTitle, setRecordDraftTitle] = useState("");
  const [recordDraftValue, setRecordDraftValue] = useState<RichEditorValue>(EMPTY_VALUE);
  const [recordDraftCodeLanguage, setRecordDraftCodeLanguage] = useState<string | null>(null);
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
      defaultCodeLanguage: recordDraftCodeLanguage,
      tagIds: recordDraftTagIds,
    });
    setRecordDraftTitle("");
    setRecordDraftValue(EMPTY_VALUE);
    setRecordDraftCodeLanguage(null);
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
              aiSettings={aiSettings}
              defaultCodeLanguage={recordDraftCodeLanguage}
              onDefaultCodeLanguageChange={setRecordDraftCodeLanguage}
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
              onOpenAiSettings={() => openSettings("ai-rewrite")}
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
            <RecordListItem
              key={note.id}
              record={note}
              scope={{ kind: "workspace", assetHandlers }}
              focused={focusId === `record-${note.id}`}
              availableTags={availableTags}
              busy={saving || savingRecordId === note.id}
              onSave={async (current, value, title, tagIds, defaultCodeLanguage) => {
                setSavingRecordId(current.id);
                try {
                  const normalized = normalizeRichEditorValue(value);
                  await onUpdateRecord(current, {
                    title: title.trim() || undefined,
                    markdown: normalized.markdown,
                    html: normalized.html,
                    defaultCodeLanguage,
                    tagIds,
                  });
                } finally {
                  setSavingRecordId(null);
                }
              }}
              onOpenContextMenu={openRecordContextMenu}
              contactMentionOptions={contactMentionOptions}
              onOpenInternalReference={onOpenInternalReference}
              active={active}
              aiSettings={aiSettings}
              scrollParentSelector="[data-testid='workspace-overview-focus-scroll']"
              onOpenFocusPage={(current) => navigate(`/workspace/records/${current.id}`)}
              onCreatedTag={syncWorkspaceTagCache}
              onOpenAiSettings={() => openSettings("ai-rewrite")}
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
