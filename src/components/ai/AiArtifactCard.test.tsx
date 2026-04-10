import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const artifactMocks = vi.hoisted(() => ({
  mockAiArtifactGet: vi.fn(),
  mockEnqueueAndWait: vi.fn(),
  mockUseAiJobTarget: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    aiArtifactGet: artifactMocks.mockAiArtifactGet,
  },
}));

vi.mock("../../lib/aiJobs", () => ({
  aiArtifactJobTargetKey: vi.fn(() => "artifact:project_brief:7:none:none"),
  artifactRefreshJobInput: vi.fn((input) => ({
    kind: "artifact_refresh",
    targetKey: "artifact:project_brief:7:none:none",
    input,
  })),
  enqueueAndWait: artifactMocks.mockEnqueueAndWait,
  isAiJobActive: vi.fn((job) => job?.status === "queued" || job?.status === "running"),
  readArtifactJobResult: vi.fn((job) => {
    if (!job.result || job.result.kind !== "artifact_refresh") {
      throw new Error("missing artifact result");
    }
    return job.result.artifact;
  }),
  resetAiJobSync: vi.fn(),
  useAiJobTarget: artifactMocks.mockUseAiJobTarget,
}));

import { AiArtifactCard } from "./AiArtifactCard";

describe("AiArtifactCard", () => {
  beforeEach(() => {
    artifactMocks.mockAiArtifactGet.mockReset();
    artifactMocks.mockEnqueueAndWait.mockReset();
    artifactMocks.mockUseAiJobTarget.mockReset();
    artifactMocks.mockUseAiJobTarget.mockReturnValue(null);
    artifactMocks.mockAiArtifactGet.mockResolvedValue({
      id: 9,
      kind: "project_brief",
      skillKey: "builtin.summary",
      skillVersion: "1.0.0",
      projectId: 7,
      activityId: null,
      artifactDate: null,
      status: "error",
      markdown: "",
      jsonPayload: {
        overview: "",
        sections: [],
      },
      sourceUpdatedAt: "2026-04-09T12:00:00Z",
      generatedAt: null,
      errorMessage: "上游服务超时，未生成概览",
      citations: [],
      createdAt: "2026-04-09T12:00:00Z",
      updatedAt: "2026-04-09T12:00:00Z",
    });
  });

  it("shows the artifact error detail on the hoverable error badge", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AiArtifactCard
            eyebrow="Project"
            title="AI 项目概览"
            input={{ kind: "project_brief", projectId: 7 }}
            aiEnabled
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const failedBadge = await screen.findByText("错误");
    expect(failedBadge).toHaveAttribute("title", "上游服务超时，未生成概览");
    expect(await screen.findByText("加载失败")).toBeInTheDocument();
    expect(screen.getByText("上游服务超时，未生成概览")).toBeInTheDocument();
  });

  it("renders sections in a single column when requested", async () => {
    artifactMocks.mockAiArtifactGet.mockResolvedValueOnce({
      id: 10,
      kind: "activity_summary",
      skillKey: "builtin.summary",
      skillVersion: "1.0.0",
      projectId: 7,
      activityId: 3,
      artifactDate: null,
      status: "fresh",
      markdown: "",
      jsonPayload: {
        overview: "本次评审已确认首版字段范围。",
        sections: [
          {
            title: "关键结论",
            items: ["官网质量可作为核心解释字段。"],
          },
          {
            title: "未决问题 / 风险",
            items: ["员工数缺失值处理策略待定。"],
          },
        ],
      },
      sourceUpdatedAt: "2026-04-09T12:00:00Z",
      generatedAt: "2026-04-09T12:05:00Z",
      errorMessage: null,
      citations: [],
      createdAt: "2026-04-09T12:05:00Z",
      updatedAt: "2026-04-09T12:05:00Z",
    });

    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AiArtifactCard
            eyebrow="Activity"
            title="AI 总结"
            input={{ kind: "activity_summary", projectId: 7, activityId: 3 }}
            aiEnabled
            sectionsLayout="single-column"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("关键结论")).toBeInTheDocument();
    expect(container.querySelector(".md\\:grid-cols-2")).not.toBeInTheDocument();
  });
});
