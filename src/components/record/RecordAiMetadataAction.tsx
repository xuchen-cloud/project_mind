import { LoaderCircle, Sparkles } from "lucide-react";
import { useRef, useState } from "react";

import { isAiCapabilityConfigured } from "../../lib/ai";
import {
  enqueueAndWait,
  readRecordMetadataJobResult,
} from "../../lib/aiJobs";
import { getErrorMessage } from "../../lib/errors";
import { buildRecordAiMetadataJobInput } from "../../lib/recordAiMetadata";
import { colorKeyForTagLabel, mergeUniqueTagIds } from "../../lib/tags";
import type {
  AiSettingsSnapshot,
  DocumentTagRecord,
  ProjectTagRecord,
} from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { Button } from "../../ui/components";

export type RecordAiMetadataTarget =
  | { scope: "workspace"; recordId: number }
  | { scope: "project"; projectId: number; recordId: number };

interface RecordAiMetadataActionProps {
  target: RecordAiMetadataTarget;
  aiSettings?: AiSettingsSnapshot | null;
  availableTags: ProjectTagRecord[];
  currentTagIds: number[];
  getCommittedMarkdown: () => string;
  beforeApply: () => Promise<unknown>;
  onApplied: (value: { title: string; tags: DocumentTagRecord[] }) => void;
  onOpenAiSettings: () => void;
}

export function RecordAiMetadataAction({
  target,
  aiSettings,
  availableTags,
  currentTagIds,
  getCommittedMarkdown,
  beforeApply,
  onApplied,
  onOpenAiSettings,
}: RecordAiMetadataActionProps) {
  const { pushToast } = useFeedbackStore();
  const [busy, setBusy] = useState(false);
  const currentTagIdsRef = useRef(currentTagIds);
  currentTagIdsRef.current = currentTagIds;

  const run = async () => {
    if (busy || aiSettings === undefined) return;

    const configured = Boolean(
      aiSettings &&
        (aiSettings.hasUsableDefault ||
          isAiCapabilityConfigured(aiSettings, "default")),
    );
    if (!configured) {
      pushToast({
        tone: "info",
        title:
          aiSettings?.aiSecretsUnlocked === false
            ? "请先解锁 AI 配置"
            : "请先配置 AI 模型",
        detail: "标题和标签填写使用 Workspace 的通用默认模型。",
      });
      onOpenAiSettings();
      return;
    }

    const markdown = getCommittedMarkdown().trim();
    if (!markdown) {
      pushToast({
        tone: "info",
        title: "正文为空",
        detail: "先写一些正文，再让 AI 填写标题和标签。",
      });
      return;
    }

    setBusy(true);
    try {
      const scopeKey =
        target.scope === "project" ? `project:${target.projectId}` : "workspace";
      const job = await enqueueAndWait(
        buildRecordAiMetadataJobInput({
          targetKey: `record-ai-metadata:${scopeKey}:${target.recordId}`,
          markdown,
          availableTags,
        }),
      );
      if (job.status !== "succeeded") {
        throw new Error(
          job.errorMessage ||
            (job.status === "cancelled" ? "AI 填写已取消" : "AI 填写未完成"),
        );
      }

      const suggestion = readRecordMetadataJobResult(job);
      await beforeApply();
      const input = {
        noteId: target.recordId,
        title: suggestion.title,
        tagIds: mergeUniqueTagIds(
          currentTagIdsRef.current,
          suggestion.existingTagIds,
        ),
        newTags: suggestion.newTags.map((label) => ({
          label,
          colorKey: colorKeyForTagLabel(label),
        })),
      };
      const record = target.scope === "project"
        ? await projectMindApi.projectRecordMetadataApply({
            ...input,
            projectId: target.projectId,
          })
        : await projectMindApi.workspaceRecordMetadataApply(input);

      onApplied({
        title: record.title ?? suggestion.title,
        tags: record.tags ?? [],
      });
      pushToast({
        tone: "success",
        title: "标题和标签已填写",
        detail: "已根据正文更新标题和标签。",
      });
    } catch (error) {
      pushToast({
        tone: "error",
        title: "AI 填写失败",
        detail: getErrorMessage(error, "无法生成标题和标签，请重试"),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="subtle"
      aria-label="AI 填写标题和标签"
      title={aiSettings === undefined ? "正在读取 AI 配置" : "从正文填写标题和标签"}
      disabled={busy || aiSettings === undefined}
      leadingIcon={
        busy ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />
      }
      onClick={() => void run()}
    >
      {busy ? "填写中" : "AI 填写"}
    </Button>
  );
}
