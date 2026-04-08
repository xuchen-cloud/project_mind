import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FileTagSettingsSnapshot } from "../../lib/types";

const {
  mockFileTagSettingsGet,
  mockFileTagOptionUpsert,
  mockFileTagOptionDelete,
  mockSetStatus,
  mockPushToast,
} = vi.hoisted(() => ({
  mockFileTagSettingsGet: vi.fn(),
  mockFileTagOptionUpsert: vi.fn(),
  mockFileTagOptionDelete: vi.fn(),
  mockSetStatus: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    fileTagSettingsGet: mockFileTagSettingsGet,
    fileTagOptionUpsert: mockFileTagOptionUpsert,
    fileTagOptionDelete: mockFileTagOptionDelete,
  },
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    setStatus: mockSetStatus,
    pushToast: mockPushToast,
  }),
}));

import { FileTagSettingsPanel } from "./FileTagSettingsPanel";

let fileTagSettingsSnapshot: FileTagSettingsSnapshot;

describe("FileTagSettingsPanel", () => {
  beforeEach(() => {
    mockFileTagSettingsGet.mockReset();
    mockFileTagOptionUpsert.mockReset();
    mockFileTagOptionDelete.mockReset();
    mockSetStatus.mockReset();
    mockPushToast.mockReset();

    fileTagSettingsSnapshot = {
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

    mockFileTagSettingsGet.mockImplementation(async () => fileTagSettingsSnapshot);
    mockFileTagOptionUpsert.mockImplementation(async (input) => {
      if (input.id) {
        const nextTag = {
          ...(fileTagSettingsSnapshot.tags.find((tag) => tag.id === input.id)!),
          label: input.label,
          colorKey: input.colorKey,
        };
        fileTagSettingsSnapshot = {
          tags: fileTagSettingsSnapshot.tags.map((tag) => (tag.id === input.id ? nextTag : tag)),
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
      fileTagSettingsSnapshot = {
        tags: [...fileTagSettingsSnapshot.tags, nextTag],
      };
      return nextTag;
    });
    mockFileTagOptionDelete.mockResolvedValue(undefined);
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
      expect(mockFileTagOptionUpsert.mock.calls[0]?.[0]).toEqual({
        label: "待审核",
        colorKey: "rose",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("例如：法务 / 合同 / 待审核")).not.toBeInTheDocument(),
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
        expect(mockFileTagOptionUpsert.mock.calls[0]?.[0]).toEqual({
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
          mockFileTagOptionUpsert.mock.calls[mockFileTagOptionUpsert.mock.calls.length - 1]?.[0],
        ).toEqual({
          id: 1,
          label: "待审核",
          colorKey: "teal",
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
      <FileTagSettingsPanel open />
    </QueryClientProvider>,
  );
}
