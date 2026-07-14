import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectTagSettingsSnapshot } from "../../lib/types";

const {
  mockProjectTagSettingsGet,
  mockProjectTagUpsert,
  mockProjectTagDelete,
  mockSetStatus,
  mockPushToast,
} = vi.hoisted(() => ({
  mockProjectTagSettingsGet: vi.fn(),
  mockProjectTagUpsert: vi.fn(),
  mockProjectTagDelete: vi.fn(),
  mockSetStatus: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    projectTagSettingsGet: mockProjectTagSettingsGet,
    projectTagUpsert: mockProjectTagUpsert,
    projectTagDelete: mockProjectTagDelete,
  },
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    setStatus: mockSetStatus,
    pushToast: mockPushToast,
  }),
}));

import { ProjectTagSettingsPanel } from "./ProjectTagSettingsPanel";

let projectTagSettingsSnapshot: ProjectTagSettingsSnapshot;

describe("ProjectTagSettingsPanel", () => {
  beforeEach(() => {
    mockProjectTagSettingsGet.mockReset();
    mockProjectTagUpsert.mockReset();
    mockProjectTagDelete.mockReset();
    mockSetStatus.mockReset();
    mockPushToast.mockReset();

    projectTagSettingsSnapshot = {
      tags: [
        {
          id: 1,
          label: "合同",
          colorKey: "blue",
          usageCount: 2,
          createdAt: "",
          updatedAt: "",
        },
      ],
    };

    mockProjectTagSettingsGet.mockImplementation(async () => projectTagSettingsSnapshot);
    mockProjectTagUpsert.mockImplementation(async (input) => {
      if (input.id) {
        const nextTag = {
          ...(projectTagSettingsSnapshot.tags.find((tag) => tag.id === input.id)!),
          label: input.label,
          colorKey: input.colorKey,
        };
        projectTagSettingsSnapshot = {
          tags: projectTagSettingsSnapshot.tags.map((tag) => (tag.id === input.id ? nextTag : tag)),
        };
        return nextTag;
      }

      const nextTag = {
        id: 2,
        label: input.label,
        colorKey: input.colorKey,
        usageCount: 0,
        createdAt: "",
        updatedAt: "",
      };
      projectTagSettingsSnapshot = {
        tags: [...projectTagSettingsSnapshot.tags, nextTag],
      };
      return nextTag;
    });
    mockProjectTagDelete.mockResolvedValue(undefined);
  });

  it("keeps the create composer collapsed until the user clicks new", async () => {
    const user = userEvent.setup();

    renderPanel();

    expect(screen.queryByPlaceholderText("例如：法务 / 合同 / 待审核")).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "新建标签" }));
    await user.type(screen.getByPlaceholderText("例如：法务 / 合同 / 待审核"), "待审核");
    await user.click(screen.getByRole("button", { name: /颜色/ }));
    await user.click(screen.getByRole("option", { name: "Rose" }));
    await user.click(screen.getByRole("button", { name: "创建标签" }));

    await waitFor(() =>
      expect(mockProjectTagUpsert.mock.calls[0]?.[0]).toEqual({
        projectId: 7,
        label: "待审核",
        colorKey: "rose",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("例如：法务 / 合同 / 待审核")).not.toBeInTheDocument(),
    );
  });

  it("loads and creates tags in the workspace scope", async () => {
    const user = userEvent.setup();

    renderPanel(null);

    expect(await screen.findByText("Workspace Tags")).toBeInTheDocument();
    expect(mockProjectTagSettingsGet).toHaveBeenCalledWith({ projectId: null });

    await user.click(screen.getByRole("button", { name: "新建标签" }));
    await user.type(screen.getByPlaceholderText("例如：法务 / 合同 / 待审核"), "稍后处理");
    await user.click(screen.getByRole("button", { name: "创建标签" }));

    await waitFor(() =>
      expect(mockProjectTagUpsert.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ projectId: null, label: "稍后处理" }),
      ),
    );
  });

  it("supports inline rename and recolor without rendering save buttons", async () => {
    const user = userEvent.setup();

    renderPanel();

    const row = (await screen.findByRole("button", { name: /合同/ })).closest("div");
    expect(row).not.toBeNull();

    await user.click(within(row!).getByRole("button", { name: "编辑" }));

    const input = screen.getByDisplayValue("合同");
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "待审核");

    await waitFor(
      () =>
        expect(mockProjectTagUpsert.mock.calls[0]?.[0]).toEqual({
          projectId: 7,
          id: 1,
          label: "待审核",
          colorKey: "blue",
        }),
      { timeout: 1500 },
    );

    const updatedRow = screen.getByRole("button", { name: /待审核/ }).closest("div");
    expect(updatedRow).not.toBeNull();
    await user.click(within(updatedRow!).getByRole("button", { name: "编辑" }));
    await user.click(within(updatedRow!).getByRole("button", { name: /颜色/ }));
    await user.click(screen.getByRole("option", { name: "Teal" }));

    await waitFor(
      () =>
        expect(
          mockProjectTagUpsert.mock.calls[mockProjectTagUpsert.mock.calls.length - 1]?.[0],
        ).toEqual({
          projectId: 7,
          id: 1,
          label: "待审核",
          colorKey: "teal",
        }),
      { timeout: 1500 },
    );
  });
});

function renderPanel(projectId: number | null = 7) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectTagSettingsPanel open projectId={projectId} />
    </QueryClientProvider>,
  );
}
