import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, RefreshCcw, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";

import {
  aiArtifactJobTargetKey,
  artifactRefreshJobInput,
  enqueueAndWait,
  isAiJobActive,
  readArtifactJobResult,
  useAiJobTarget,
} from "../../lib/aiJobs";
import { aiArtifactQueryKey, citationPath } from "../../lib/aiArtifacts";
import { getErrorMessage } from "../../lib/errors";
import type { AiArtifactGetInput } from "../../lib/types";
import { formatDateTime } from "../../lib/formatters";
import { projectMindApi } from "../../services/projectMindApi";
import { useUiStore } from "../../state/ui-store";
import {
  Button,
  EmptyState,
  SectionHeader,
  StatusBadge,
  SurfaceCard,
} from "../../ui/components";
import { cn } from "../../ui/lib/cn";

interface AiArtifactCardProps {
  eyebrow: string;
  title: string;
  description?: string;
  input: AiArtifactGetInput;
  aiEnabled: boolean;
  sectionsLayout?: "auto" | "single-column";
}

export function AiArtifactCard({
  eyebrow,
  title,
  description,
  input,
  aiEnabled,
  sectionsLayout = "auto",
}: AiArtifactCardProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { openSettings } = useUiStore();

  const queryKey = useMemo(() => aiArtifactQueryKey(input), [input]);
  const targetKey = useMemo(() => aiArtifactJobTargetKey(input), [input]);
  const autoRefreshKey = queryKey.join(":");
  const autoRequestedRef = useRef(false);
  const [jobError, setJobError] = useState<string | null>(null);

  useEffect(() => {
    autoRequestedRef.current = false;
    setJobError(null);
  }, [autoRefreshKey]);

  const artifactQuery = useQuery({
    queryKey,
    queryFn: () => projectMindApi.aiArtifactGet(input),
  });

  const artifactJob = useAiJobTarget(targetKey);
  const artifactJobActive = isAiJobActive(artifactJob);

  useEffect(() => {
    if (artifactJob?.status !== "succeeded" || artifactJob.result?.kind !== "artifact_refresh") {
      if (artifactJob?.status === "failed") {
        setJobError(artifactJob.errorMessage ?? "AI 概览生成失败");
      }
      return;
    }

    setJobError(null);
    queryClient.setQueryData(queryKey, readArtifactJobResult(artifactJob));
  }, [artifactJob, queryClient, queryKey]);

  const artifact = artifactQuery.data ?? null;
  const hasRenderableContent =
    Boolean(artifact?.jsonPayload.overview?.trim()) ||
    Boolean(artifact?.jsonPayload.sections?.length);
  const isInitialGenerating = !artifact && (artifactQuery.isLoading || artifactJobActive);
  const requestErrorDetail = normalizeErrorMessage(artifactQuery.error ?? jobError);
  const artifactErrorDetail =
    artifact?.status === "error" ? artifact.errorMessage ?? "AI 概览生成失败" : null;
  const statusErrorDetail = requestErrorDetail ?? artifactErrorDetail;

  const refreshArtifact = useCallback(async () => {
    setJobError(null);

    try {
      const job = await enqueueAndWait(artifactRefreshJobInput(input));
      if (job.status === "failed") {
        setJobError(job.errorMessage ?? "AI 概览生成失败");
      }
    } catch (error) {
      setJobError(getErrorMessage(error, "AI 概览生成失败"));
    }
  }, [input]);

  useEffect(() => {
    if (!aiEnabled || autoRequestedRef.current || artifactQuery.isLoading || artifact || artifactJobActive) {
      return;
    }
    autoRequestedRef.current = true;
    void refreshArtifact();
  }, [aiEnabled, artifact, artifactJobActive, artifactQuery.isLoading, refreshArtifact]);

  const statusMeta = useMemo(() => {
    if (!aiEnabled) {
      return { tone: "neutral" as const, label: "未配置" };
    }
    if (artifactJob?.status === "queued") {
      return { tone: "accent" as const, label: "排队中" };
    }
    if (artifactJob?.status === "running") {
      return { tone: "accent" as const, label: "生成中" };
    }
    if (statusErrorDetail) {
      return { tone: "danger" as const, label: "错误" };
    }
    if (!artifact) {
      return { tone: "neutral" as const, label: "待生成" };
    }
    if (artifact.status === "fresh") {
      return { tone: "success" as const, label: "最新" };
    }
    if (artifact.status === "stale") {
      return { tone: "warning" as const, label: "待刷新" };
    }
    return { tone: "danger" as const, label: "错误" };
  }, [aiEnabled, artifact, artifactJob?.status, statusErrorDetail]);

  return (
    <section className="grid gap-4">
      <SectionHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge
              tone={statusMeta.tone}
              title={statusMeta.tone === "danger" ? statusErrorDetail ?? undefined : undefined}
              className={statusMeta.tone === "danger" ? "cursor-help" : undefined}
            >
              {statusMeta.label}
            </StatusBadge>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={!aiEnabled || artifactJobActive}
              leadingIcon={
                artifactJobActive ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <RefreshCcw size={14} />
                )
              }
              onClick={() => void refreshArtifact()}
            >
              刷新总结
            </Button>
          </div>
        }
      />

      <SurfaceCard subtle className="grid gap-4 p-4">
        {!aiEnabled ? (
          <EmptyState
            title="Summary 能力未配置"
            text="先在设置里绑定可用的 Summary 模型，AI 才能生成活动总结、项目概览和 Today。"
            icon={<Sparkles size={16} />}
            action={
              <Button type="button" variant="primary" onClick={() => openSettings("ai")}>
                打开 AI 设置
              </Button>
            }
            className="w-full"
          />
        ) : isInitialGenerating ? (
          <div className="flex min-h-32 items-center justify-center gap-2 text-body text-text-soft">
            <LoaderCircle className="spin" size={16} />
            {artifactJob?.status === "queued" ? "AI 概览已进入队列..." : "正在整理 AI 概览..."}
          </div>
        ) : requestErrorDetail ? (
          <EmptyState
            title="加载失败"
            text={requestErrorDetail}
            className="w-full"
            action={
              <Button type="button" variant="primary" onClick={() => void refreshArtifact()}>
                重试生成
              </Button>
            }
          />
        ) : artifact?.status === "error" && artifactErrorDetail && !hasRenderableContent ? (
          <EmptyState
            title="加载失败"
            text={artifactErrorDetail}
            className="w-full"
            action={
              <Button type="button" variant="primary" onClick={() => void refreshArtifact()}>
                重试生成
              </Button>
            }
          />
        ) : !artifact || !hasRenderableContent ? (
          <EmptyState
            title="还没有 AI 概览"
            text="当前还没有可展示的结果，可以手动刷新生成一版。"
            className="w-full"
            action={
              <Button type="button" variant="primary" onClick={() => void refreshArtifact()}>
                立即生成
              </Button>
            }
          />
        ) : (
          <>
            {artifact.status === "stale" ? (
              <div className="rounded-[var(--radius-8)] border border-[color-mix(in_srgb,var(--color-warning)_26%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-warning)_8%,var(--color-bg))] px-3 py-2 text-ui text-text-muted">
                源数据有更新，这份概览可能已经过期。需要时可以手动刷新。
              </div>
            ) : null}

            {artifact.status === "error" && artifact.errorMessage ? (
              <div className="rounded-[var(--radius-8)] border border-[color-mix(in_srgb,var(--color-danger)_24%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-danger)_7%,var(--color-bg))] px-3 py-2 text-ui text-text-muted">
                最近一次刷新失败：{artifact.errorMessage}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-ui text-text-soft">
              {artifact.generatedAt ? <span>生成于 {formatDateTime(artifact.generatedAt)}</span> : null}
              <span>来源更新于 {formatDateTime(artifact.sourceUpdatedAt)}</span>
            </div>

            <div className="grid gap-3">
              <div className="rounded-[var(--radius-8)] bg-bg px-4 py-4">
                <p className="whitespace-pre-wrap text-body leading-7 text-text">
                  {artifact.jsonPayload.overview}
                </p>
              </div>

              <div className={cn("grid gap-3", sectionsLayout !== "single-column" && "md:grid-cols-2")}>
                {artifact.jsonPayload.sections.map((section) => (
                  <div
                    key={section.title}
                    className="rounded-[var(--radius-8)] border border-border bg-bg px-4 py-4"
                  >
                    <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                      {section.title}
                    </p>
                    {section.items.length > 0 ? (
                      <ul className="mt-3 grid gap-2">
                        {section.items.map((item, index) => (
                          <li
                            key={`${section.title}-${index}`}
                            className="grid grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-2 text-body leading-6 text-text"
                          >
                            <span className="pt-1 text-text-soft">•</span>
                            <span>{item}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-3 text-body text-text-soft">暂无可展示内容。</p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between gap-3">
                <p className="text-ui font-medium uppercase tracking-[0.16em] text-text-soft">
                  来源引用
                </p>
                <StatusBadge tone="neutral">{artifact.citations.length} 条</StatusBadge>
              </div>
              {artifact.citations.length > 0 ? (
                <div className="grid gap-2">
                  {artifact.citations.map((citation) => {
                    const targetPath = citationPath(citation);

                    return (
                      <button
                        key={citation.id}
                        type="button"
                        className="grid gap-1 rounded-[var(--radius-8)] border border-border bg-bg px-3 py-3 text-left transition-colors hover:bg-bg-hover"
                        disabled={!targetPath}
                        onClick={() => {
                          if (targetPath) {
                            navigate(targetPath);
                          }
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-body font-medium text-text">{citation.label}</p>
                          <StatusBadge tone="neutral">{citation.sourceKind}</StatusBadge>
                        </div>
                        <p className="line-clamp-2 text-ui leading-6 text-text-soft">
                          {citation.excerpt || "暂无摘录"}
                        </p>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <EmptyState text="这次生成结果还没有引用来源。" compact />
              )}
            </div>
          </>
        )}
      </SurfaceCard>
    </section>
  );
}

function normalizeErrorMessage(error: unknown) {
  if (!error) {
    return null;
  }

  return getErrorMessage(error);
}
