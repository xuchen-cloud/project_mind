import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettingsSnapshot } from "../../lib/types";

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    aiJobsListActive: vi.fn(async () => []),
    aiJobGet: vi.fn(async () => null),
  },
}));

const aiJobMocks = vi.hoisted(() => ({
  enqueueAndWait: vi.fn(),
  useAiJobTarget: vi.fn(),
}));

vi.mock("../../lib/aiJobs", () => ({
  aiAskJobTargetKey: vi.fn(() => "ask:project:7:none"),
  answerQuestionJobInput: vi.fn((input) => ({ kind: "answer_question", targetKey: "ask:project:7:none", input })),
  enqueueAndWait: aiJobMocks.enqueueAndWait,
  isAiJobActive: vi.fn((job) => job?.status === "queued" || job?.status === "running"),
  readAnswerJobResult: vi.fn((job) => {
    if (!job.result || job.result.kind !== "answer_question") {
      throw new Error("missing answer result");
    }
    return job.result.answer;
  }),
  resetAiJobSync: vi.fn(),
  useAiJobTarget: aiJobMocks.useAiJobTarget,
}));

import { AskPanel } from "./AskPanel";
import { useUiStore } from "../../state/ui-store";

function configuredAiSettings(): AiSettingsSnapshot {
  return {
    profiles: [
      {
        id: 1,
        name: "Assistant",
        providerFamily: "openai_compatible" as const,
        baseUrl: "https://mock.local/v1",
        apiKeyLast4: "1234",
        hasStoredKey: true,
        defaultModel: "mock-model",
        supportsText: true,
        supportsImage: false,
        supportsFile: false,
        enabled: true,
        createdAt: "",
        updatedAt: "",
      },
    ],
    bindings: [
      {
        capability: "default" as const,
        useDefault: false,
        profileId: 1,
        model: "mock-model",
        updatedAt: "",
      },
      {
        capability: "assistant" as const,
        useDefault: false,
        profileId: 1,
        model: "mock-model",
        updatedAt: "",
      },
    ],
    hasUsableDefault: true,
    securityMode: "workspace_password_encrypted",
    aiSecretsUnlocked: true,
    execution: {
      maxConcurrency: 1,
    },
    featureSettings: {
      masterEnabled: true,
      capabilities: {
        assistant: true,
        summary: true,
        suggestion_generation: true,
      },
      features: {
        "summary.activity_summary": true,
        "summary.project_brief": true,
        "summary.daily_brief": true,
        "suggestion_generation.conclusion": true,
        "suggestion_generation.todo": true,
      },
    },
  };
}

function renderPanel(aiSettings = configuredAiSettings()) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AskPanel
          open
          scope="project"
          allowedScopes={["project", "workspace"]}
          projectId={7}
          activityId={null}
          aiSettings={aiSettings}
          onUnlockAiSecrets={vi.fn(async () => true)}
          onClose={vi.fn()}
          onScopeChange={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AskPanel", () => {
  beforeEach(() => {
    aiJobMocks.enqueueAndWait.mockReset();
    aiJobMocks.useAiJobTarget.mockReset();
    aiJobMocks.useAiJobTarget.mockReturnValue(null);
    useUiStore.setState({
      createProjectOpen: false,
      createActivityOpen: false,
      settingsOpen: false,
      settingsSection: "activity",
      projectComposer: null,
      projectSidebarCollapsed: false,
      todoRailCollapsed: false,
    });
  });

  it("shows a controlled empty state when assistant is not configured", async () => {
    const user = userEvent.setup();
    renderPanel({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "workspace_password_encrypted",
      aiSecretsUnlocked: true,
      execution: {
        maxConcurrency: 1,
      },
      featureSettings: {
        masterEnabled: true,
        capabilities: {
          assistant: true,
          summary: true,
          suggestion_generation: true,
        },
        features: {
          "summary.activity_summary": true,
          "summary.project_brief": true,
          "summary.daily_brief": true,
          "suggestion_generation.conclusion": true,
          "suggestion_generation.todo": true,
        },
      },
    });

    expect(await screen.findByText("Assistant 能力未配置")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "打开 AI 设置" }));

    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsSection).toBe("ai");
  });

  it("renders the latest answer and replaces previous results on a new question", async () => {
    const user = userEvent.setup();
    aiJobMocks.enqueueAndWait
      .mockResolvedValueOnce({
        status: "succeeded",
        result: {
          kind: "answer_question",
          answer: {
            answerMarkdown: "项目当前最重要的是先确认预算边界。",
            citations: [
              {
                refCode: "TODO-9",
                sourceKind: "todo",
                sourceId: 9,
                projectId: 7,
                activityId: null,
                label: "Open Todo",
                excerpt: "尽快确认预算范围",
              },
            ],
            scope: "project",
            generatedAt: "2026-04-08T10:00:00Z",
            skillKey: "builtin.ask",
            skillVersion: "1.0.0",
          },
        },
      })
      .mockResolvedValueOnce({
        status: "succeeded",
        result: {
          kind: "answer_question",
          answer: {
            answerMarkdown: "目前最明显的阻塞是法务反馈还没回来。",
            citations: [
              {
                refCode: "CONCLUSION-3",
                sourceKind: "conclusion",
                sourceId: 3,
                projectId: 7,
                activityId: 2,
                label: "Project Conclusion",
                excerpt: "等待法务确认条款修改建议",
              },
            ],
            scope: "project",
            generatedAt: "2026-04-08T10:05:00Z",
            skillKey: "builtin.ask",
            skillVersion: "1.0.0",
          },
        },
      });

    renderPanel();

    expect(await screen.findByRole("button", { name: "当前项目" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "当前活动" })).not.toBeInTheDocument();
    expect(await screen.findByText("开始提问")).toBeInTheDocument();

    await user.type(
      screen.getByRole("textbox", { name: "问题" }),
      "最近最重要的事情是什么？",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "提问" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "提问" }));

    expect(await screen.findByText("项目当前最重要的是先确认预算边界。")).toBeInTheDocument();
    expect(screen.getByText("Open Todo")).toBeInTheDocument();
    expect(aiJobMocks.enqueueAndWait).toHaveBeenCalledTimes(1);

    await user.clear(screen.getByRole("textbox", { name: "问题" }));
    await user.type(screen.getByRole("textbox", { name: "问题" }), "当前最大的阻塞是什么？");
    await user.click(screen.getByRole("button", { name: "提问" }));

    expect(await screen.findByText("目前最明显的阻塞是法务反馈还没回来。")).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByText("项目当前最重要的是先确认预算边界。"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Project Conclusion")).toBeInTheDocument();
  });

  it("shows the job failure detail when asking fails", async () => {
    const user = userEvent.setup();
    aiJobMocks.enqueueAndWait.mockResolvedValueOnce({
      status: "failed",
      errorMessage:
        "OpenAI-compatible provider returned an unexpected response shape. top-level keys: data, usage",
    });

    renderPanel();

    await screen.findByRole("button", { name: "当前项目" });
    await user.type(screen.getByLabelText("问题"), "现在最重要的事情是什么？");
    await user.click(screen.getByRole("button", { name: "提问" }));

    expect(await screen.findByText("提问失败")).toBeInTheDocument();
    expect(
      screen.getByText(
        "OpenAI-compatible provider returned an unexpected response shape. top-level keys: data, usage",
      ),
    ).toBeInTheDocument();
  });
});
