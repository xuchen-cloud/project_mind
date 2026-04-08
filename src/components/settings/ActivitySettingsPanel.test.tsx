import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivitySettingsSnapshot } from "../../lib/types";

const {
  mockActivitySettingsGet,
  mockActivityAttributeOptionUpsert,
  mockActivityAttributeOptionDelete,
  mockActivityStatusOptionUpsert,
  mockActivityStatusOptionDelete,
  mockSetStatus,
  mockPushToast,
} = vi.hoisted(() => ({
  mockActivitySettingsGet: vi.fn(),
  mockActivityAttributeOptionUpsert: vi.fn(),
  mockActivityAttributeOptionDelete: vi.fn(),
  mockActivityStatusOptionUpsert: vi.fn(),
  mockActivityStatusOptionDelete: vi.fn(),
  mockSetStatus: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    activitySettingsGet: mockActivitySettingsGet,
    activityAttributeOptionUpsert: mockActivityAttributeOptionUpsert,
    activityAttributeOptionDelete: mockActivityAttributeOptionDelete,
    activityStatusOptionUpsert: mockActivityStatusOptionUpsert,
    activityStatusOptionDelete: mockActivityStatusOptionDelete,
  },
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    setStatus: mockSetStatus,
    pushToast: mockPushToast,
  }),
}));

import { ActivitySettingsPanel } from "./ActivitySettingsPanel";

let activitySettingsSnapshot: ActivitySettingsSnapshot;

describe("ActivitySettingsPanel", () => {
  beforeEach(() => {
    mockActivitySettingsGet.mockReset();
    mockActivityAttributeOptionUpsert.mockReset();
    mockActivityAttributeOptionDelete.mockReset();
    mockActivityStatusOptionUpsert.mockReset();
    mockActivityStatusOptionDelete.mockReset();
    mockSetStatus.mockReset();
    mockPushToast.mockReset();

    activitySettingsSnapshot = {
      activityAttributeOptions: [
        { id: 1, label: "LEGAL", colorKey: "blue", createdAt: "", updatedAt: "" },
      ],
      activityStatusOptions: [
        {
          id: 2,
          label: "待启动",
          colorKey: "amber",
          isSystem: true,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: 3,
          label: "已整理",
          colorKey: "green",
          isSystem: false,
          createdAt: "",
          updatedAt: "",
        },
      ],
    };
    mockActivitySettingsGet.mockImplementation(async () => activitySettingsSnapshot);
    mockActivityAttributeOptionUpsert.mockImplementation(async (input) => {
      if (input.id) {
        const nextOption = {
          ...(activitySettingsSnapshot.activityAttributeOptions.find((option) => option.id === input.id)!),
          label: input.label,
          colorKey: input.colorKey,
        };
        activitySettingsSnapshot = {
          ...activitySettingsSnapshot,
          activityAttributeOptions: activitySettingsSnapshot.activityAttributeOptions.map((option) =>
            option.id === input.id ? nextOption : option,
          ),
        };
        return nextOption;
      }

      const nextOption = {
        id: 4,
        label: input.label,
        colorKey: input.colorKey,
        createdAt: "",
        updatedAt: "",
      };
      activitySettingsSnapshot = {
        ...activitySettingsSnapshot,
        activityAttributeOptions: [...activitySettingsSnapshot.activityAttributeOptions, nextOption],
      };
      return nextOption;
    });
    mockActivityAttributeOptionDelete.mockResolvedValue({
      activityAttributeOptions: [],
      activityStatusOptions: [],
    });
    mockActivityStatusOptionUpsert.mockImplementation(async (input) => {
      const nextOption = {
        ...(activitySettingsSnapshot.activityStatusOptions.find((option) => option.id === input.id)!),
        label: input.label,
        colorKey: input.colorKey,
      };
      activitySettingsSnapshot = {
        ...activitySettingsSnapshot,
        activityStatusOptions: activitySettingsSnapshot.activityStatusOptions.map((option) =>
          option.id === input.id ? nextOption : option,
        ),
      };
      return nextOption;
    });
    mockActivityStatusOptionDelete.mockResolvedValue({
      activityAttributeOptions: [],
      activityStatusOptions: [],
    });
  });

  it("keeps the create composer collapsed until the user clicks new", async () => {
    const user = userEvent.setup();

    renderPanel();

    expect(screen.queryByPlaceholderText("新增活动属性")).not.toBeInTheDocument();

    await user.click((await screen.findAllByRole("button", { name: "新建" }))[0]);
    await user.type(screen.getByPlaceholderText("新增活动属性"), "LEGAL OPS");
    await user.click(screen.getByRole("button", { name: /颜色/ }));
    await user.click(screen.getByRole("option", { name: "Amber" }));
    await user.click(screen.getByRole("button", { name: "创建属性" }));

    await waitFor(() =>
      expect(mockActivityAttributeOptionUpsert.mock.calls[0]?.[0]).toEqual({
        label: "LEGAL OPS",
        colorKey: "amber",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("新增活动属性")).not.toBeInTheDocument(),
    );
  });

  it("auto-saves attribute label and color after entering inline edit mode", async () => {
    const user = userEvent.setup();

    renderPanel();

    const row = (await screen.findByRole("button", { name: "LEGAL" })).closest("div");
    expect(row).not.toBeNull();
    expect(screen.queryByDisplayValue("LEGAL")).not.toBeInTheDocument();

    await user.click(within(row!).getByRole("button", { name: "编辑" }));

    const attributeField = screen.getByDisplayValue("LEGAL");
    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();

    await user.clear(attributeField);
    await user.type(attributeField, "LEGAL OPS");

    await waitFor(
      () =>
        expect(mockActivityAttributeOptionUpsert.mock.calls[0]?.[0]).toEqual({
          id: 1,
          label: "LEGAL OPS",
          colorKey: "blue",
        }),
      { timeout: 1500 },
    );

    await user.click(within(row!).getByRole("button", { name: "编辑" }));
    await user.click(within(row!).getByRole("button", { name: /颜色/ }));
    await user.click(screen.getByRole("option", { name: "Amber" }));

    await waitFor(
      () =>
        expect(
          mockActivityAttributeOptionUpsert.mock.calls[
            mockActivityAttributeOptionUpsert.mock.calls.length - 1
          ]?.[0],
        ).toEqual({
          id: 1,
          label: "LEGAL OPS",
          colorKey: "amber",
        }),
      { timeout: 1500 },
    );
  });

  it("auto-saves status label and color after entering inline edit mode", async () => {
    const user = userEvent.setup();

    renderPanel();

    const statusRow = (await screen.findByRole("button", { name: "已整理" })).closest("div");
    expect(statusRow).not.toBeNull();

    await user.click(within(statusRow!).getByRole("button", { name: "编辑" }));

    const statusField = screen.getByDisplayValue("已整理");
    await user.clear(statusField);
    await user.type(statusField, "已归档");

    await waitFor(
      () =>
        expect(mockActivityStatusOptionUpsert.mock.calls[0]?.[0]).toEqual({
          id: 3,
          label: "已归档",
          colorKey: "green",
        }),
      { timeout: 1500 },
    );

    await user.click(within(statusRow!).getByRole("button", { name: "编辑" }));
    await user.click(within(statusRow!).getByRole("button", { name: /状态颜色/ }));
    await user.click(screen.getByRole("option", { name: "Rose" }));

    await waitFor(
      () =>
        expect(
          mockActivityStatusOptionUpsert.mock.calls[
            mockActivityStatusOptionUpsert.mock.calls.length - 1
          ]?.[0],
        ).toEqual({
          id: 3,
          label: "已归档",
          colorKey: "rose",
        }),
      { timeout: 1500 },
    );
  });

  it("keeps the system status row non-deletable while still allowing inline edit", async () => {
    const user = userEvent.setup();

    renderPanel();

    const pendingRow = (await screen.findByRole("button", { name: "待启动" })).closest("div");
    expect(pendingRow).not.toBeNull();
    expect(within(pendingRow!).getByText("默认")).toBeInTheDocument();
    expect(within(pendingRow!).queryByRole("button", { name: "删除" })).not.toBeInTheDocument();

    await user.click(within(pendingRow!).getByRole("button", { name: "编辑" }));
    const pendingField = screen.getByDisplayValue("待启动");
    await user.clear(pendingField);
    await user.type(pendingField, "待排期");

    await waitFor(
      () =>
        expect(mockActivityStatusOptionUpsert.mock.calls[0]?.[0]).toEqual({
          id: 2,
          label: "待排期",
          colorKey: "amber",
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
      <ActivitySettingsPanel open />
    </QueryClientProvider>,
  );
}
