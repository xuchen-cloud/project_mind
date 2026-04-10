import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { AiArtifactCard } from "../ai/AiArtifactCard";
import { workspaceDayString } from "../../lib/aiArtifacts";
import { isAiFeatureReady, isAiFeatureVisible } from "../../lib/ai";
import { projectMindApi } from "../../services/projectMindApi";
import { EmptyState } from "../../ui/components";

export function TodayPage() {
  const today = useMemo(() => workspaceDayString(), []);
  const projectsQuery = useQuery({
    queryKey: ["projects", "all"],
    queryFn: () => projectMindApi.projectsList({ includeArchived: true }),
  });
  const aiSettingsQuery = useQuery({
    queryKey: ["ai-settings"],
    queryFn: projectMindApi.aiSettingsGet,
  });

  const visibleProjects = useMemo(
    () => (projectsQuery.data ?? []).filter((project) => !project.isArchived),
    [projectsQuery.data],
  );
  const showToday = isAiFeatureVisible(aiSettingsQuery.data, "summary.daily_brief");
  const aiEnabled = isAiFeatureReady(aiSettingsQuery.data, "summary.daily_brief");

  if (!showToday) {
    return null;
  }

  return (
    <section className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-8 py-8">
        <div className="grid gap-2">
          <p className="text-caption font-medium uppercase tracking-[0.16em] text-text-soft">
            Workspace
          </p>
          <h1 className="text-display font-medium tracking-tight text-text">Today</h1>
          <p className="max-w-3xl text-body leading-7 text-text-muted">
            聚合今天最值得优先处理的事项，帮我们快速判断现在该推进什么。
          </p>
          <p className="text-ui text-text-soft">日期：{today}</p>
        </div>

        {!projectsQuery.isLoading && visibleProjects.length === 0 ? (
          <EmptyState
            title="还没有可聚合的项目"
            text="先创建项目并开始记录后，Today 才会汇总全局待办、最近活动和建议跟进。"
            className="w-full"
          />
        ) : (
          <AiArtifactCard
            eyebrow="Today"
            title="今日概览"
            description="汇总全局 open todos、最近活动变化和建议跟进行动。"
            input={{ kind: "daily_brief", artifactDate: today }}
            aiEnabled={aiEnabled}
          />
        )}
      </div>
    </section>
  );
}
