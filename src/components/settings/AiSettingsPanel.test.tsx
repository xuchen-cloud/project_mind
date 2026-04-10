import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSettingsSnapshot } from "../../lib/types";

const {
  mockAiSettingsGet,
  mockAiBindingUpsert,
  mockAiFeatureSettingsUpsert,
  mockAiExecutionSettingsUpsert,
  mockAiProfileUpsert,
  mockAiProfileDelete,
  mockAiProfileTest,
  mockEnqueueAndWait,
  mockUseAiJobTarget,
  mockSetStatus,
  mockPushToast,
} = vi.hoisted(() => ({
  mockAiSettingsGet: vi.fn(),
  mockAiBindingUpsert: vi.fn(),
  mockAiFeatureSettingsUpsert: vi.fn(),
  mockAiExecutionSettingsUpsert: vi.fn(),
  mockAiProfileUpsert: vi.fn(),
  mockAiProfileDelete: vi.fn(),
  mockAiProfileTest: vi.fn(),
  mockEnqueueAndWait: vi.fn(),
  mockUseAiJobTarget: vi.fn(),
  mockSetStatus: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    aiSettingsGet: mockAiSettingsGet,
    aiBindingUpsert: mockAiBindingUpsert,
    aiFeatureSettingsUpsert: mockAiFeatureSettingsUpsert,
    aiExecutionSettingsUpsert: mockAiExecutionSettingsUpsert,
    aiProfileUpsert: mockAiProfileUpsert,
    aiProfileDelete: mockAiProfileDelete,
    aiProfileTest: mockAiProfileTest,
  },
}));

vi.mock("../../lib/aiJobs", () => ({
  aiProfileTestJobTargetKey: vi.fn(() => "profile-test:draft"),
  enqueueAndWait: mockEnqueueAndWait,
  isAiJobActive: vi.fn(() => false),
  profileTestJobInput: vi.fn((input) => ({
    kind: "profile_test",
    targetKey: "profile-test:draft",
    input,
  })),
  readProfileTestJobResult: vi.fn((job) => job.result.testResult),
  resetAiJobSync: vi.fn(),
  useAiJobTarget: mockUseAiJobTarget,
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    setStatus: mockSetStatus,
    pushToast: mockPushToast,
  }),
}));

import { AiSettingsPanel } from "./AiSettingsPanel";

let aiSettingsSnapshot: AiSettingsSnapshot;

describe("AiSettingsPanel", () => {
  beforeEach(() => {
    mockAiSettingsGet.mockReset();
    mockAiBindingUpsert.mockReset();
    mockAiFeatureSettingsUpsert.mockReset();
    mockAiExecutionSettingsUpsert.mockReset();
    mockAiProfileUpsert.mockReset();
    mockAiProfileDelete.mockReset();
    mockAiProfileTest.mockReset();
    mockEnqueueAndWait.mockReset();
    mockUseAiJobTarget.mockReset();
    mockSetStatus.mockReset();
    mockPushToast.mockReset();
    mockEnqueueAndWait.mockImplementation(async (input) => ({
      status: "succeeded",
      result: {
        kind: "profile_test",
        testResult: {
          success: true,
          message: "连接成功，可用于文本能力",
          latencyMs: 12,
          resolvedModel: input.input.defaultModel,
        },
      },
    }));
    mockUseAiJobTarget.mockReturnValue(null);

    aiSettingsSnapshot = {
      profiles: [
        {
          id: 1,
          name: "OpenAI Prod",
          providerFamily: "openai_compatible",
          baseUrl: "https://api.openai.com/v1",
          apiKeyLast4: "1234",
          hasStoredKey: true,
          defaultModel: "gpt-5.4-mini",
          supportsText: true,
          supportsImage: true,
          supportsFile: false,
          enabled: true,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: 2,
          name: "Gemini",
          providerFamily: "gemini_compatible",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          apiKeyLast4: "5678",
          hasStoredKey: true,
          defaultModel: "gemini-2.5-flash",
          supportsText: true,
          supportsImage: true,
          supportsFile: false,
          enabled: true,
          createdAt: "",
          updatedAt: "",
        },
      ],
      bindings: [
        {
          capability: "default",
          useDefault: false,
          profileId: 1,
          model: "gpt-5.4-mini",
          updatedAt: "",
        },
        {
          capability: "assistant",
          useDefault: true,
          profileId: null,
          model: null,
          updatedAt: "",
        },
        {
          capability: "summary",
          useDefault: true,
          profileId: null,
          model: null,
          updatedAt: "",
        },
        {
          capability: "suggestion_generation",
          useDefault: true,
          profileId: null,
          model: null,
          updatedAt: "",
        },
      ],
      hasUsableDefault: true,
      securityMode: "local_encrypted",
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

    mockAiSettingsGet.mockImplementation(async () => aiSettingsSnapshot);
    mockAiProfileUpsert.mockImplementation(async (input) => {
      const nextProfile = {
        id: 3,
        name: input.name,
        providerFamily: input.providerFamily,
        baseUrl: input.baseUrl,
        apiKeyLast4: input.apiKey ? input.apiKey.slice(-4) : "",
        hasStoredKey: Boolean(input.apiKey),
        defaultModel: input.defaultModel,
        supportsText: input.supportsText,
        supportsImage: input.supportsImage,
        supportsFile: input.supportsFile,
        enabled: input.enabled,
        createdAt: "",
        updatedAt: "",
      };
      aiSettingsSnapshot = {
        ...aiSettingsSnapshot,
        profiles: [...aiSettingsSnapshot.profiles, nextProfile],
      };
      return nextProfile;
    });
    mockAiBindingUpsert.mockImplementation(async (input) => {
      const nextBinding = {
        capability: input.capability,
        useDefault: input.useDefault,
        profileId: input.profileId ?? null,
        model: input.model ?? null,
        updatedAt: "",
      };
      aiSettingsSnapshot = {
        ...aiSettingsSnapshot,
        bindings: aiSettingsSnapshot.bindings.map((binding) =>
          binding.capability === input.capability ? nextBinding : binding,
        ),
      };
      return nextBinding;
    });
    mockAiFeatureSettingsUpsert.mockImplementation(async (input) => {
      aiSettingsSnapshot = {
        ...aiSettingsSnapshot,
        featureSettings: input,
      };
      return input;
    });
    mockAiExecutionSettingsUpsert.mockImplementation(async (input) => input);
  });

  it("reveals the create form only after clicking the card-level create button", async () => {
    const user = userEvent.setup();

    renderPanel();

    await screen.findByRole("button", { name: "新建" });
    expect(screen.queryByLabelText("名称")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新建" }));

    await user.type(await screen.findByLabelText("名称"), "New Profile");
    await user.type(screen.getByLabelText("API Key"), "sk-test-1234");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mockAiProfileUpsert).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText("New Profile").length).toBeGreaterThan(0));
  });

  it("expands an existing profile inline within the same panel", async () => {
    const user = userEvent.setup();

    renderPanel();

    await screen.findByRole("heading", { name: "接入配置" });
    expect(screen.queryByLabelText("名称")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /OpenAI Prod/ }));

    expect(await screen.findByLabelText("名称")).toHaveValue("OpenAI Prod");

    await user.click(screen.getByRole("button", { name: /OpenAI Prod/ }));

    await waitFor(() => expect(screen.queryByLabelText("名称")).not.toBeInTheDocument());
  });

  it("uses normal and advanced modes instead of per-row inherit toggles", async () => {
    const user = userEvent.setup();

    renderPanel();

    await screen.findByText("能力绑定");
    expect(screen.queryByText("继承默认")).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("接入配置")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "专业模式" }));
    expect(screen.getAllByLabelText("接入配置")).toHaveLength(4);

    await user.selectOptions(screen.getAllByLabelText("接入配置")[1], "2");

    await waitFor(
      () =>
        expect(mockAiBindingUpsert.mock.calls[0]?.[0]).toEqual({
          capability: "assistant",
          useDefault: false,
          profileId: 2,
          model: "gpt-5.4-mini",
        }),
      { timeout: 1500 },
    );

    await user.click(screen.getByRole("button", { name: "普通模式" }));

    await waitFor(
      () =>
        expect(mockAiBindingUpsert.mock.calls[mockAiBindingUpsert.mock.calls.length - 1]?.[0]).toEqual({
          capability: "assistant",
          useDefault: true,
        }),
      { timeout: 1500 },
    );
  });

  it("updates AI execution concurrency from the scheduling card", async () => {
    const user = userEvent.setup();

    renderPanel();

    await screen.findByText("AI 调度");
    await user.click(screen.getByRole("button", { name: "3 并行" }));

    await waitFor(() =>
      expect(mockAiExecutionSettingsUpsert).toHaveBeenCalledWith(
        { maxConcurrency: 3 },
        expect.anything(),
      ),
    );
  });

  it("shows the failed test detail on the hoverable error badge", async () => {
    const user = userEvent.setup();
    mockEnqueueAndWait.mockResolvedValueOnce({
      status: "failed",
      errorMessage: "上游服务返回 401",
    });

    renderPanel();

    await screen.findByRole("heading", { name: "接入配置" });
    await user.click(screen.getByRole("button", { name: /OpenAI Prod/ }));
    await user.click(await screen.findByRole("button", { name: "测试" }));

    const failedBadge = await screen.findByText("failed");
    await waitFor(() => expect(failedBadge).toHaveAttribute("title", "上游服务返回 401"));
  });

  it("renders global, capability, and subfeature toggles", async () => {
    renderPanel();

    await screen.findByText("能力开关");
    expect(screen.getByRole("button", { name: "全局 AI开关" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask开关" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI 总结开关" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI 提炼开关" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activity 总结开关" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "项目概览开关" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Today开关" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "结论候选开关" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Todo 候选开关" })).toBeInTheDocument();
  });

  it("keeps child toggle values when the parent capability is turned off and back on", async () => {
    const user = userEvent.setup();

    renderPanel();

    await screen.findByText("能力开关");
    const summaryToggle = screen.getByRole("button", { name: "AI 总结开关" });
    const activitySummaryToggle = screen.getByRole("button", { name: "Activity 总结开关" });

    await user.click(activitySummaryToggle);

    await waitFor(() =>
      expect(mockAiFeatureSettingsUpsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          features: expect.objectContaining({
            "summary.activity_summary": false,
          }),
        }),
        expect.anything(),
      ),
    );
    expect(activitySummaryToggle).toHaveAttribute("aria-pressed", "false");

    await user.click(summaryToggle);

    await waitFor(() =>
      expect(mockAiFeatureSettingsUpsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          capabilities: expect.objectContaining({
            summary: false,
          }),
        }),
        expect.anything(),
      ),
    );
    expect(summaryToggle).toHaveAttribute("aria-pressed", "false");
    expect(activitySummaryToggle).toHaveAttribute("aria-pressed", "false");
    expect(activitySummaryToggle).toBeDisabled();

    await user.click(summaryToggle);

    await waitFor(() =>
      expect(mockAiFeatureSettingsUpsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          capabilities: expect.objectContaining({
            summary: true,
          }),
        }),
        expect.anything(),
      ),
    );
    expect(summaryToggle).toHaveAttribute("aria-pressed", "true");
    expect(activitySummaryToggle).toHaveAttribute("aria-pressed", "false");
    expect(activitySummaryToggle).not.toBeDisabled();
  });

  it("updates the global AI switch without overwriting saved child states", async () => {
    const user = userEvent.setup();

    renderPanel();

    await screen.findByText("能力开关");
    const globalToggle = screen.getByRole("button", { name: "全局 AI开关" });
    const conclusionToggle = screen.getByRole("button", { name: "结论候选开关" });

    await user.click(conclusionToggle);

    await waitFor(() =>
      expect(mockAiFeatureSettingsUpsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          features: expect.objectContaining({
            "suggestion_generation.conclusion": false,
          }),
        }),
        expect.anything(),
      ),
    );

    await user.click(globalToggle);

    await waitFor(() =>
      expect(mockAiFeatureSettingsUpsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          masterEnabled: false,
          features: expect.objectContaining({
            "suggestion_generation.conclusion": false,
          }),
        }),
        expect.anything(),
      ),
    );
    expect(globalToggle).toHaveAttribute("aria-pressed", "false");
    expect(conclusionToggle).toHaveAttribute("aria-pressed", "false");
    expect(conclusionToggle).toBeDisabled();

    await user.click(globalToggle);

    await waitFor(() =>
      expect(mockAiFeatureSettingsUpsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          masterEnabled: true,
          features: expect.objectContaining({
            "suggestion_generation.conclusion": false,
          }),
        }),
        expect.anything(),
      ),
    );
    expect(globalToggle).toHaveAttribute("aria-pressed", "true");
    expect(conclusionToggle).toHaveAttribute("aria-pressed", "false");
    expect(conclusionToggle).not.toBeDisabled();
  });
});

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AiSettingsPanel open />
    </QueryClientProvider>,
  );
}
