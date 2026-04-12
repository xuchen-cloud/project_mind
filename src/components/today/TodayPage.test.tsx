import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  projectsList: vi.fn(),
  aiSettingsGet: vi.fn(),
  workspaceTodoList: vi.fn(),
  workspaceNoteList: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: apiMocks,
}));

vi.mock("../../hooks/useTodoMutations", () => ({
  useTodoMutations: () => ({
    todoContentMutation: { mutateAsync: vi.fn() },
    todoDeleteMutation: { mutateAsync: vi.fn() },
    todoPriorityMutation: { mutateAsync: vi.fn() },
    todoProgressMutation: { mutateAsync: vi.fn() },
    todoStatusMutation: { mutateAsync: vi.fn() },
  }),
}));

vi.mock("../../hooks/useWorkspaceNoteMutations", () => ({
  useWorkspaceNoteMutations: () => ({
    workspaceNoteMutation: { mutateAsync: vi.fn(), isPending: false },
    workspaceNoteDeleteMutation: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("../ai/AiArtifactCard", () => ({
  AiArtifactCard: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("./TodayTodoSection", () => ({
  TodayTodoSection: () => <div>workspace todo section</div>,
}));

vi.mock("./WorkspaceNotesPanel", () => ({
  WorkspaceNotesPanel: () => <div>workspace notes panel</div>,
}));

import { TodayPage } from "./TodayPage";

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <TodayPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("TodayPage", () => {
  beforeEach(() => {
    apiMocks.projectsList.mockReset();
    apiMocks.aiSettingsGet.mockReset();
    apiMocks.workspaceTodoList.mockReset();
    apiMocks.workspaceNoteList.mockReset();
  });

  it("shows the AI card area when daily brief is enabled", async () => {
    apiMocks.projectsList.mockResolvedValueOnce([
      {
        id: 1,
        name: "Alpha",
        status: "active",
        rootPath: "/tmp/alpha",
        summary: "",
        isArchived: false,
        createdAt: "",
        updatedAt: "",
        activityCount: 1,
        unorganizedCount: 0,
        openTodoCount: 1,
      },
    ]);
    apiMocks.aiSettingsGet.mockResolvedValueOnce({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "workspace_password_encrypted",
      aiSecretsUnlocked: true,
      execution: { maxConcurrency: 1 },
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
    apiMocks.workspaceTodoList.mockResolvedValueOnce([]);
    apiMocks.workspaceNoteList.mockResolvedValueOnce([]);

    renderPage();

    expect(await screen.findByText("今日概览")).toBeInTheDocument();
    expect(screen.getByText("workspace todo section")).toBeInTheDocument();
    expect(screen.getByText("workspace notes panel")).toBeInTheDocument();
  });

  it("keeps Today usable without the AI card when daily brief is off", async () => {
    apiMocks.projectsList.mockResolvedValueOnce([]);
    apiMocks.aiSettingsGet.mockResolvedValueOnce({
      profiles: [],
      bindings: [],
      hasUsableDefault: false,
      securityMode: "workspace_password_encrypted",
      aiSecretsUnlocked: true,
      execution: { maxConcurrency: 1 },
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
          "summary.daily_brief": false,
          "suggestion_generation.conclusion": true,
          "suggestion_generation.todo": true,
        },
      },
    });
    apiMocks.workspaceTodoList.mockResolvedValueOnce([]);
    apiMocks.workspaceNoteList.mockResolvedValueOnce([]);

    renderPage();

    expect(await screen.findByText("workspace todo section")).toBeInTheDocument();
    expect(screen.getByText("workspace notes panel")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText("今日概览")).not.toBeInTheDocument();
    });
  });
});
