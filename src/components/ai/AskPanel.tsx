import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, LoaderCircle, SendHorizontal, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { isAiCapabilityConfigured } from "../../lib/ai";
import { askScopeLabel } from "../../lib/aiAsk";
import {
  aiAskJobTargetKey,
  answerQuestionJobInput,
  enqueueAndWait,
  isAiJobActive,
  readAnswerJobResult,
  useAiJobTarget,
} from "../../lib/aiJobs";
import { citationPath } from "../../lib/aiArtifacts";
import { getErrorMessage } from "../../lib/errors";
import { formatDateTime } from "../../lib/formatters";
import type { AiAnswerResult, AiAnswerScope, AiSettingsSnapshot } from "../../lib/types";
import { renderMarkdownToHtml } from "../rich-editor/markdown";
import { useUiStore } from "../../state/ui-store";
import {
  Button,
  Dialog,
  EmptyState,
  StatusBadge,
  SurfaceCard,
} from "../../ui/components";

interface AskPanelProps {
  open: boolean;
  scope: AiAnswerScope;
  allowedScopes: AiAnswerScope[];
  projectId: number | null;
  activityId: number | null;
  aiSettings?: AiSettingsSnapshot;
  aiSettingsLoading?: boolean;
  onClose: () => void;
  onScopeChange: (scope: AiAnswerScope) => void;
}

export function AskPanel({
  open,
  scope,
  allowedScopes,
  projectId,
  activityId,
  aiSettings,
  aiSettingsLoading = false,
  onClose,
  onScopeChange,
}: AskPanelProps) {
  const navigate = useNavigate();
  const { openSettings } = useUiStore();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AiAnswerResult | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const targetKey = useMemo(
    () => aiAskJobTargetKey(scope, projectId, activityId),
    [activityId, projectId, scope],
  );

  const answerJob = useAiJobTarget(targetKey);
  const answerJobActive = isAiJobActive(answerJob);

  const assistantReady = isAiCapabilityConfigured(aiSettings, "assistant");

  useEffect(() => {
    setAnswer(null);
    setRequestError(null);
  }, [scope, projectId, activityId]);

  const answerHtml = useMemo(
    () => renderMarkdownToHtml(answer?.answerMarkdown),
    [answer?.answerMarkdown],
  );

  const canSubmit = assistantReady && question.trim().length > 0 && !answerJobActive;

  const handleSubmit = () => {
    const trimmed = question.trim();
    if (!trimmed || !assistantReady || answerJobActive) {
      return;
    }

    setAnswer(null);
    setRequestError(null);
    void enqueueAndWait(
      answerQuestionJobInput(
        {
          scope,
          question: trimmed,
          projectId: scope === "workspace" ? undefined : projectId ?? undefined,
          activityId: scope === "activity" ? activityId ?? undefined : undefined,
        },
        projectId,
        activityId,
      ),
    )
      .then((job) => {
        if (job.status !== "succeeded") {
          setRequestError(job.errorMessage ?? "提问失败");
          return;
        }
        setAnswer(readAnswerJobResult(job));
        setRequestError(null);
      })
      .catch((error) => {
        setAnswer(null);
        setRequestError(getErrorMessage(error, "提问失败"));
      });
  };

  return (
    <Dialog
      open={open}
      title="Ask"
      description="基于当前页面可见范围提问，答案只使用本地检索到的原始对象，并尽量附带可回跳的引用。"
      onClose={onClose}
      widthClassName="max-w-4xl"
      bodyClassName="grid gap-4"
    >
      <div className="grid gap-4">
        <SurfaceCard subtle className="grid gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
              当前范围
            </span>
            {allowedScopes.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={[
                  "rounded-full border px-3 py-1.5 text-ui font-medium transition-colors",
                  candidate === scope
                    ? "border-[color-mix(in_srgb,var(--color-accent)_24%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-bg))] text-accent"
                    : "border-border bg-bg text-text-muted hover:border-border-strong hover:text-text",
                ].join(" ")}
                onClick={() => onScopeChange(candidate)}
              >
                {askScopeLabel(candidate)}
              </button>
            ))}
          </div>

          <div className="grid gap-3">
            <label className="grid gap-2">
              <span className="text-ui font-medium text-text">问题</span>
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSubmit();
                  }
                }}
                rows={4}
                placeholder="例如：这个范围里最近最值得优先推进的事情是什么？"
                className="min-h-28 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3 text-body text-text outline-none transition-colors placeholder:text-text-soft focus:border-border-strong"
              />
            </label>

            <div className="flex items-center justify-between gap-3">
              <p className="text-ui text-text-soft">
                默认只保留最新一条回答，不记录聊天历史。
              </p>
              <Button
                type="button"
                variant="primary"
                disabled={!canSubmit}
                leadingIcon={
                  answerJobActive ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : (
                    <SendHorizontal size={14} />
                  )
                }
                onClick={handleSubmit}
              >
                提问
              </Button>
            </div>
          </div>
        </SurfaceCard>

        {!open ? null : aiSettingsLoading ? (
          <SurfaceCard subtle className="flex min-h-52 items-center justify-center gap-2 p-4 text-body text-text-soft">
            <LoaderCircle className="spin" size={16} />
            正在检查 Ask 能力配置...
          </SurfaceCard>
        ) : !assistantReady ? (
          <EmptyState
            title="Assistant 能力未配置"
            text="先在设置里绑定可用的 Assistant 模型，Ask 才能基于当前范围回答问题。"
            icon={<Sparkles size={16} />}
            action={
              <Button type="button" variant="primary" onClick={() => openSettings("ai")}>
                打开 AI 设置
              </Button>
            }
            className="w-full"
          />
        ) : answerJobActive ? (
          <SurfaceCard subtle className="flex min-h-52 items-center justify-center gap-2 p-4 text-body text-text-soft">
            <LoaderCircle className="spin" size={16} />
            {answerJob?.status === "queued" ? "问题已进入队列..." : "正在检索并组织答案..."}
          </SurfaceCard>
        ) : requestError ? (
          <EmptyState
            title="提问失败"
            text={requestError}
            action={
              <Button type="button" variant="primary" onClick={handleSubmit}>
                重试
              </Button>
            }
            className="w-full"
          />
        ) : answer ? (
          <div className="grid gap-4">
            <SurfaceCard subtle className="grid gap-4 p-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-ui text-text-soft">
                <StatusBadge tone="accent">{askScopeLabel(answer.scope)}</StatusBadge>
                <span>生成于 {formatDateTime(answer.generatedAt)}</span>
              </div>
              <div
                className="grid gap-3 text-body leading-7 text-text"
                dangerouslySetInnerHTML={{ __html: answerHtml }}
              />
            </SurfaceCard>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                  来源引用
                </p>
                <StatusBadge tone="neutral">{answer.citations.length} 条</StatusBadge>
              </div>

              {answer.citations.length > 0 ? (
                <div className="grid gap-2">
                  {answer.citations.map((citation) => {
                    const targetPath = citationPath(citation);

                    return (
                      <button
                        key={citation.refCode}
                        type="button"
                        className="grid gap-1 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3 text-left transition-colors hover:bg-bg-hover"
                        disabled={!targetPath}
                        onClick={() => {
                          if (!targetPath) {
                            return;
                          }
                          navigate(targetPath);
                          onClose();
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-body font-medium text-text">{citation.label}</p>
                          <div className="flex items-center gap-2">
                            <StatusBadge tone="neutral">{citation.sourceKind}</StatusBadge>
                            {targetPath ? <ArrowUpRight size={14} className="text-text-soft" /> : null}
                          </div>
                        </div>
                        <p className="line-clamp-2 text-ui leading-6 text-text-soft">
                          {citation.excerpt || "暂无摘录"}
                        </p>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <EmptyState
                  text="这次回答没有足够证据形成可跳转引用，建议换个更具体的问题继续提问。"
                  compact
                />
              )}
            </div>
          </div>
        ) : (
          <EmptyState
            title="开始提问"
            text="Ask 会根据当前范围检索项目、活动、结论、Todo、文件与有限的记录内容，并返回最新一条答案。"
            className="w-full"
          />
        )}
      </div>
    </Dialog>
  );
}
