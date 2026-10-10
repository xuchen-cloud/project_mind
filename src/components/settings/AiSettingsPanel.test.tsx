import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSettingsSnapshot } from "../../lib/types";

const {
  mockAiSettingsGet,
  mockAiBindingUpsert,
  mockAiExecutionSettingsUpsert,
  mockAiNetworkSettingsUpsert,
  mockAiProfileUpsert,
  mockAiProfileDelete,
  mockAiProfileTest,
  mockAiEditorSkillUpsert,
  mockAiEditorSkillDelete,
  mockAiEditorSkillReorder,
  mockEnqueueAndWait,
  mockUseAiJobTarget,
  mockSetStatus,
  mockPushToast,
} = vi.hoisted(() => ({
  mockAiSettingsGet: vi.fn(),
  mockAiBindingUpsert: vi.fn(),
  mockAiExecutionSettingsUpsert: vi.fn(),
  mockAiNetworkSettingsUpsert: vi.fn(),
  mockAiProfileUpsert: vi.fn(),
  mockAiProfileDelete: vi.fn(),
  mockAiProfileTest: vi.fn(),
  mockAiEditorSkillUpsert: vi.fn(),
  mockAiEditorSkillDelete: vi.fn(),
  mockAiEditorSkillReorder: vi.fn(),
  mockEnqueueAndWait: vi.fn(),
  mockUseAiJobTarget: vi.fn(),
  mockSetStatus: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    aiSettingsGet: mockAiSettingsGet,
    aiBindingUpsert: mockAiBindingUpsert,
    aiExecutionSettingsUpsert: mockAiExecutionSettingsUpsert,
    aiNetworkSettingsUpsert: mockAiNetworkSettingsUpsert,
    aiProfileUpsert: mockAiProfileUpsert,
    aiProfileDelete: mockAiProfileDelete,
    aiProfileTest: mockAiProfileTest,
    aiEditorSkillUpsert: mockAiEditorSkillUpsert,
    aiEditorSkillDelete: mockAiEditorSkillDelete,
    aiEditorSkillReorder: mockAiEditorSkillReorder,
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
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    mockAiSettingsGet.mockReset();
    mockAiBindingUpsert.mockReset();
    mockAiExecutionSettingsUpsert.mockReset();
    mockAiNetworkSettingsUpsert.mockReset();
    mockAiProfileUpsert.mockReset();
    mockAiProfileDelete.mockReset();
    mockAiProfileTest.mockReset();
    mockAiEditorSkillUpsert.mockReset();
    mockAiEditorSkillDelete.mockReset();
    mockAiEditorSkillReorder.mockReset();
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
          capability: "image_default",
          useDefault: false,
          profileId: null,
          model: null,
          updatedAt: "",
        },
      ],
      hasUsableDefault: true,
      hasUsableImageDefault: false,
      securityMode: "workspace_password_encrypted",
      aiSecretsUnlocked: true,
      execution: {
        maxConcurrency: 1,
      },
      network: { mode: "system", proxyUrl: null, username: null, hasStoredPassword: false },
      editorSkills: [],
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
    mockAiEditorSkillUpsert.mockImplementation(async (input) => {
      const nextSkill = {
        id: input.id ?? `skill-${aiSettingsSnapshot.editorSkills.length + 1}`,
        name: input.name,
        icon: input.icon || null,
        description: input.description || null,
        prompt: input.prompt,
        resultMode: input.resultMode,
        showInTextMenu: input.showInTextMenu,
        showInImageMenu: input.showInImageMenu,
        profileId: input.profileId ?? null,
        sortOrder: input.sortOrder ?? aiSettingsSnapshot.editorSkills.length + 1,
        enabled: input.enabled,
        createdAt: "",
        updatedAt: "",
      };
      aiSettingsSnapshot = {
        ...aiSettingsSnapshot,
        editorSkills: input.id
          ? aiSettingsSnapshot.editorSkills.map((skill) =>
              skill.id === input.id ? nextSkill : skill,
            )
          : [...aiSettingsSnapshot.editorSkills, nextSkill],
      };
      return nextSkill;
    });
    mockAiEditorSkillDelete.mockImplementation(async ({ skillId }) => {
      aiSettingsSnapshot = {
        ...aiSettingsSnapshot,
        editorSkills: aiSettingsSnapshot.editorSkills.filter(
          (skill) => skill.id !== skillId,
        ),
      };
      return aiSettingsSnapshot.editorSkills;
    });
    mockAiEditorSkillReorder.mockImplementation(async ({ skillIds }) => {
      aiSettingsSnapshot = {
        ...aiSettingsSnapshot,
        editorSkills: skillIds
          .map((skillId, index) => {
            const skill = aiSettingsSnapshot.editorSkills.find((item) => item.id === skillId);
            return skill ? { ...skill, sortOrder: index + 1 } : null;
          })
          .filter(Boolean),
      } as AiSettingsSnapshot;
      return aiSettingsSnapshot.editorSkills;
    });
    mockAiExecutionSettingsUpsert.mockImplementation(async (input) => input);
    mockAiNetworkSettingsUpsert.mockImplementation(async (input) => {
      const saved = {
        mode: input.mode,
        proxyUrl: input.proxyUrl,
        username: input.username ?? null,
        hasStoredPassword: Boolean(input.password),
      };
      aiSettingsSnapshot = { ...aiSettingsSnapshot, network: saved };
      return saved;
    });
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

    await screen.findByRole("heading", { name: "AI 模型配置" });
    expect(screen.queryByLabelText("名称")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /OpenAI Prod/ }));

    expect(await screen.findByLabelText("名称")).toHaveValue("OpenAI Prod");

    await user.click(screen.getByRole("button", { name: /OpenAI Prod/ }));

    await waitFor(() => expect(screen.queryByLabelText("名称")).not.toBeInTheDocument());
  });

  it("restores profile disclosure focus and cancels a closing exit when reopened", async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByRole("heading", { name: "AI 模型配置" });
    const trigger = screen.getByRole("button", { name: /OpenAI Prod/u });
    await user.click(trigger);
    const nameInput = await screen.findByLabelText("名称");
    nameInput.focus();
    vi.useFakeTimers();

    fireEvent.click(trigger);
    const closingPanel = document.querySelector(".disclosure-presence") as HTMLElement;
    expect(trigger).toHaveFocus();
    expect(closingPanel).toHaveAttribute("data-state", "closing");
    expect(closingPanel).toHaveAttribute("aria-hidden", "true");
    expect(closingPanel).toHaveAttribute("inert");

    fireEvent.click(trigger);
    act(() => vi.advanceTimersByTime(160));

    expect(screen.getByLabelText("名称")).toBeInTheDocument();
    expect(document.querySelectorAll(".disclosure-presence")).toHaveLength(1);
  });

  it("renders only general and image default model bindings", async () => {
    const user = userEvent.setup();

    renderPanel();

    await screen.findByText("模型绑定");
    expect(screen.queryByText("继承默认")).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("接入配置")).toHaveLength(2);

    await user.selectOptions(screen.getAllByLabelText("接入配置")[1], "2");

    await waitFor(
      () =>
        expect(mockAiBindingUpsert.mock.calls[0]?.[0]).toEqual({
          capability: "image_default",
          useDefault: false,
          profileId: 2,
          model: undefined,
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

  it("saves a custom proxy and refreshes the displayed setting", async () => {
    const user = userEvent.setup();
    renderPanel();

    const mode = await screen.findByLabelText("连接方式");
    expect(mode).toHaveValue("system");
    await user.selectOptions(mode, "custom");
    await user.type(screen.getByLabelText("代理地址"), "http://127.0.0.1:7890");
    await user.click(screen.getByRole("button", { name: "保存连接方式" }));

    await waitFor(() =>
      expect(mockAiNetworkSettingsUpsert).toHaveBeenCalledWith(
        { mode: "custom", proxyUrl: "http://127.0.0.1:7890", username: null },
      ),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "保存连接方式" })).toBeDisabled());
    expect(screen.getByLabelText("代理地址")).toHaveValue("http://127.0.0.1:7890");
    expect(mockSetStatus).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "success", message: "AI 连接设置已保存" }),
    );
  });

  it("saves separate proxy credentials without displaying the saved password", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.selectOptions(await screen.findByLabelText("连接方式"), "custom");
    await user.type(screen.getByLabelText("代理地址"), "http://127.0.0.1:7890");
    await user.type(screen.getByLabelText("代理用户名（可选）"), "proxy-user");
    await user.type(screen.getByLabelText("代理密码（可选）"), "proxy-secret");
    await user.click(screen.getByRole("button", { name: "保存连接方式" }));

    await waitFor(() => expect(mockAiNetworkSettingsUpsert).toHaveBeenCalledWith(
      { mode: "custom", proxyUrl: "http://127.0.0.1:7890", username: "proxy-user", password: "proxy-secret" },
    ));
    await waitFor(() => expect(screen.getByLabelText("代理密码（可选）")).toHaveValue(""));
    expect(screen.getByLabelText("代理密码（可选）")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("代理密码（可选）")).toHaveAttribute("placeholder", "已保存，留空保持");
    expect(aiSettingsSnapshot.network).toEqual({
      mode: "custom", proxyUrl: "http://127.0.0.1:7890", username: "proxy-user", hasStoredPassword: true,
    });
  });

  it("omits a blank password when the username changes and lets the backend clear the old secret", async () => {
    const user = userEvent.setup();
    aiSettingsSnapshot = {
      ...aiSettingsSnapshot,
      network: {
        mode: "custom", proxyUrl: "http://127.0.0.1:7890", username: "proxy-user", hasStoredPassword: true,
      },
    };
    mockAiNetworkSettingsUpsert.mockImplementation(async (input) => {
      const saved = {
        mode: input.mode,
        proxyUrl: input.proxyUrl,
        username: input.username,
        hasStoredPassword: false,
      };
      aiSettingsSnapshot = { ...aiSettingsSnapshot, network: saved };
      return saved;
    });
    renderPanel();

    await screen.findByLabelText("代理密码（可选）");
    await user.type(screen.getByLabelText("代理用户名（可选）"), "2");
    await user.click(screen.getByRole("button", { name: "保存连接方式" }));
    await waitFor(() => expect(mockAiNetworkSettingsUpsert).toHaveBeenCalledWith(
      { mode: "custom", proxyUrl: "http://127.0.0.1:7890", username: "proxy-user2" },
    ));
    await waitFor(() => expect(screen.queryByRole("button", { name: "清除已保存密码" })).not.toBeInTheDocument());
  });

  it("explicitly clears a saved proxy password", async () => {
    const user = userEvent.setup();
    aiSettingsSnapshot = {
      ...aiSettingsSnapshot,
      network: {
        mode: "custom", proxyUrl: "http://127.0.0.1:7890", username: "proxy-user", hasStoredPassword: true,
      },
    };
    mockAiNetworkSettingsUpsert.mockImplementation(async (input) => {
      const saved = { mode: input.mode, proxyUrl: input.proxyUrl, username: input.username, hasStoredPassword: false };
      aiSettingsSnapshot = { ...aiSettingsSnapshot, network: saved };
      return saved;
    });
    renderPanel();

    await screen.findByRole("button", { name: "清除已保存密码" });
    await user.click(screen.getByRole("button", { name: "清除已保存密码" }));
    expect(screen.getByRole("button", { name: "保留已保存密码" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存连接方式" }));
    await waitFor(() => expect(mockAiNetworkSettingsUpsert).toHaveBeenLastCalledWith(
      { mode: "custom", proxyUrl: "http://127.0.0.1:7890", username: "proxy-user", password: "" },
    ));
    await waitFor(() => expect(screen.queryByRole("button", { name: "清除已保存密码" })).not.toBeInTheDocument());
  });

  it("accepts credentials in a proxy URL and displays the cleaned address returned by the backend", async () => {
    const user = userEvent.setup();
    mockAiNetworkSettingsUpsert.mockImplementationOnce(async () => {
      const saved = {
        mode: "custom" as const,
        proxyUrl: "http://127.0.0.1:7890/",
        username: "proxy-user",
        hasStoredPassword: true,
      };
      aiSettingsSnapshot = { ...aiSettingsSnapshot, network: saved };
      return saved;
    });
    renderPanel();

    await user.selectOptions(await screen.findByLabelText("连接方式"), "custom");
    await user.type(screen.getByLabelText("代理地址"), "http://proxy-user:proxy-secret@127.0.0.1:7890");
    await user.click(screen.getByRole("button", { name: "保存连接方式" }));

    await waitFor(() => expect(mockAiNetworkSettingsUpsert).toHaveBeenCalledWith(
      { mode: "custom", proxyUrl: "http://proxy-user:proxy-secret@127.0.0.1:7890", username: null },
    ));
    await waitFor(() => expect(screen.getByLabelText("代理地址")).toHaveValue("http://127.0.0.1:7890/"));
    expect(screen.getByLabelText("代理用户名（可选）")).toHaveValue("proxy-user");
    expect(screen.getByLabelText("代理密码（可选）")).toHaveValue("");
  });

  it("hides the proxy URL in system and direct modes", async () => {
    const user = userEvent.setup();
    aiSettingsSnapshot = {
      ...aiSettingsSnapshot,
      network: { mode: "custom", proxyUrl: "http://127.0.0.1:7890", username: null, hasStoredPassword: false },
    };
    renderPanel();

    const mode = await screen.findByLabelText("连接方式");
    expect(screen.getByLabelText("代理地址")).toHaveValue("http://127.0.0.1:7890");
    await user.selectOptions(mode, "system");
    expect(screen.queryByLabelText("代理地址")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存连接方式" }));
    await waitFor(() => expect(mockAiNetworkSettingsUpsert).toHaveBeenCalledWith(
      { mode: "system", proxyUrl: null },
    ));
    await waitFor(() => expect(screen.getByRole("button", { name: "保存连接方式" })).toBeDisabled());
    await user.selectOptions(mode, "direct");
    expect(screen.queryByLabelText("代理地址")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存连接方式" }));
    await waitFor(() => expect(mockAiNetworkSettingsUpsert).toHaveBeenLastCalledWith(
      { mode: "direct", proxyUrl: null },
    ));
  });

  it("keeps a failed proxy change unsaved and shows the native error feedback", async () => {
    const user = userEvent.setup();
    mockAiNetworkSettingsUpsert.mockRejectedValueOnce(new Error("代理地址无效"));
    renderPanel();

    await user.selectOptions(await screen.findByLabelText("连接方式"), "custom");
    await user.type(screen.getByLabelText("代理地址"), "socks5://127.0.0.1:7890");
    await user.click(screen.getByRole("button", { name: "保存连接方式" }));

    await waitFor(() => expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error", detail: "代理地址无效" }),
    ));
    expect(screen.getByRole("button", { name: "保存连接方式" })).toBeEnabled();
    expect(screen.getByLabelText("代理地址")).toHaveValue("socks5://127.0.0.1:7890");
    expect(aiSettingsSnapshot.network).toEqual({ mode: "system", proxyUrl: null, username: null, hasStoredPassword: false });
    expect(mockSetStatus).not.toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });

  it("creates a custom editor AI skill from the settings panel", async () => {
    const user = userEvent.setup();

    renderPanel("rewrite");

    await screen.findByText("AI 技能");
    await user.click(screen.getByRole("button", { name: "新增技能" }));
    await user.type(await screen.findByLabelText("技能名称"), "翻译成英文");
    await user.type(
      screen.getByPlaceholderText("比如：请保持原意，把这段文字翻译成自然、专业的英文。"),
      "请翻译成自然英文",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(mockAiEditorSkillUpsert).toHaveBeenCalledWith(
        {
          id: undefined,
          name: "翻译成英文",
          icon: "",
          description: "",
          prompt: "请翻译成自然英文",
          resultMode: "modify",
          showInTextMenu: true,
          showInImageMenu: false,
          profileId: null,
          sortOrder: undefined,
          enabled: true,
        },
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

    await screen.findByRole("heading", { name: "AI 模型配置" });
    await user.click(screen.getByRole("button", { name: /OpenAI Prod/ }));
    await user.click(await screen.findByRole("button", { name: "测试" }));

    const failedBadge = await screen.findByText("failed");
    await waitFor(() => expect(failedBadge).toHaveAttribute("title", "上游服务返回 401"));
  });

  it("disables new AI skills after the saved skill limit", async () => {
    aiSettingsSnapshot = {
      ...aiSettingsSnapshot,
      editorSkills: Array.from({ length: 24 }, (_, index) => ({
        id: `skill-${index + 1}`,
        name: `技能 ${index + 1}`,
        icon: null,
        description: null,
        prompt: `提示词 ${index + 1}`,
        resultMode: "modify",
        showInTextMenu: true,
        sortOrder: index + 1,
        enabled: true,
        createdAt: "",
        updatedAt: "",
      })),
    };

    renderPanel("rewrite");

    await screen.findByText("24/24 个技能");
    expect(screen.getByRole("button", { name: "新增技能" })).toBeDisabled();
    expect(screen.getByText(/已达到 24 个技能上限/)).toBeInTheDocument();
  });

  it("keeps an Editor Skill disclosure inert while closing and restores trigger focus", async () => {
    const user = userEvent.setup();
    aiSettingsSnapshot = {
      ...aiSettingsSnapshot,
      editorSkills: [
        {
          id: "skill-1",
          name: "提炼摘要",
          icon: null,
          description: "提炼关键信息",
          prompt: "请提炼摘要",
          resultMode: "modify",
          showInTextMenu: true,
          showInImageMenu: false,
          profileId: null,
          sortOrder: 1,
          enabled: true,
          createdAt: "",
          updatedAt: "",
        },
      ],
    };
    renderPanel("rewrite");

    await screen.findByText("提炼摘要");
    const trigger = screen.getByRole("button", { name: "展开" });
    await user.click(trigger);
    const nameInput = await screen.findByLabelText("技能名称");
    nameInput.focus();
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    const closingPanel = document.querySelector(".disclosure-presence") as HTMLElement;
    expect(trigger).toHaveFocus();
    expect(closingPanel).toHaveAttribute("data-state", "closing");
    expect(closingPanel).toHaveAttribute("aria-hidden", "true");

    act(() => vi.advanceTimersByTime(159));
    expect(document.querySelector(".disclosure-presence")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(document.querySelector(".disclosure-presence")).not.toBeInTheDocument();
  });
});

function renderPanel(section: "models" | "rewrite" = "models") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <AiSettingsPanel open section={section} />
    </QueryClientProvider>,
  );
}
