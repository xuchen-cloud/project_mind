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
import { recordDocumentApi } from "../../services/recordDocumentApi";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";
import type { RecordMetadata, RecordTarget } from "../../lib/record-document-types";
import { useFeedbackStore } from "../../state/feedback-store";
import { Button } from "../../ui/components";

export type RecordAiMetadataTarget =
  | { scope: "workspace"; recordId: number }
  | { scope: "project"; projectId: number; recordId: number };

interface RecordAiMetadataActionProps {
  target: RecordAiMetadataTarget;
  binding: AgentWorkspaceBinding | null;
  onSubmitted?: (requestId: string) => void;
  aiSettings?: AiSettingsSnapshot | null;
  availableTags: ProjectTagRecord[];
  currentTagIds: number[];
  getCommittedMarkdown: () => string;
  beforeApply: () => Promise<unknown>;
  onApplied: (value: { title: string; tags: DocumentTagRecord[]; metadata: RecordMetadata; expectedRevision: string }) => void;
  onOpenAiSettings: () => void;
}

export function RecordAiMetadataAction({
  target,
  binding,
  onSubmitted,
  aiSettings,
  availableTags,
  getCommittedMarkdown,
  beforeApply,
  onApplied,
  onOpenAiSettings,
}: RecordAiMetadataActionProps) {
  const { pushToast } = useFeedbackStore();
  const [busy, setBusy] = useState(false);
  const identityRef = useRef("");
  identityRef.current = `${binding?.workspaceId}:${binding?.generation}:${JSON.stringify(target)}`;

  const run = async () => {
    if (busy || aiSettings === undefined || !binding) return;

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

    const identity = identityRef.current;
    const recordTarget: RecordTarget = { scope: target.scope === "project" ? { kind: "project", projectId: target.projectId } : { kind: "workspace" }, recordId: target.recordId };
    setBusy(true);
    try {
      await beforeApply();
      if (identity !== identityRef.current) throw new Error("记录已切换，AI 元信息未写入");
      const baseline = await recordDocumentApi.metadataGet(binding,recordTarget);
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
      if (identity !== identityRef.current) throw new Error("记录已切换，AI 元信息未写入");
      await beforeApply();
      if (identity !== identityRef.current) throw new Error("记录已切换，AI 元信息未写入");
      const requestId = crypto.randomUUID();
      onSubmitted?.(requestId);
      const result = await recordDocumentApi.metadataApply(binding,{
        metadata: { target: recordTarget, title: suggestion.title, expectedRevision: baseline.revision,
          tagIds: mergeUniqueTagIds(baseline.tagIds, suggestion.existingTagIds) },
        newTags: suggestion.newTags.map((label) => ({ label,colorKey: colorKeyForTagLabel(label) })),
      },requestId);
      if (identity !== identityRef.current) return;
      onApplied({ title: result.metadata.title ?? suggestion.title, tags: result.tags, metadata: result.metadata, expectedRevision: baseline.revision });
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
      disabled={busy || aiSettings === undefined || !binding}
      leadingIcon={
        busy ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />
      }
      onClick={() => void run()}
    >
      {busy ? "填写中" : "AI 填写"}
    </Button>
  );
}
