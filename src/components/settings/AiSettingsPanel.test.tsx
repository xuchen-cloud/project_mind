import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSettingsSnapshot } from "../../lib/types";

const {
  mockAiSettingsGet,
  mockAiBindingUpsert,
  mockAiProfileUpsert,
  mockAiProfileDelete,
  mockAiProfileTest,
  mockSetStatus,
  mockPushToast,
} = vi.hoisted(() => ({
  mockAiSettingsGet: vi.fn(),
  mockAiBindingUpsert: vi.fn(),
  mockAiProfileUpsert: vi.fn(),
  mockAiProfileDelete: vi.fn(),
  mockAiProfileTest: vi.fn(),
  mockSetStatus: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    aiSettingsGet: mockAiSettingsGet,
    aiBindingUpsert: mockAiBindingUpsert,
    aiProfileUpsert: mockAiProfileUpsert,
    aiProfileDelete: mockAiProfileDelete,
    aiProfileTest: mockAiProfileTest,
  },
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
    mockAiProfileUpsert.mockReset();
    mockAiProfileDelete.mockReset();
    mockAiProfileTest.mockReset();
    mockSetStatus.mockReset();
    mockPushToast.mockReset();

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
  });

  it("reveals the create form only after clicking the card-level create button", async () => {
    const user = userEvent.setup();

    renderPanel();

    await screen.findByRole("button", { name: "新建配置" });
    expect(screen.queryByLabelText("名称")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新建配置" }));

    await user.type(await screen.findByLabelText("名称"), "New Profile");
    await user.type(screen.getByLabelText("API Key"), "sk-test-1234");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mockAiProfileUpsert).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText("New Profile").length).toBeGreaterThan(0));
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
