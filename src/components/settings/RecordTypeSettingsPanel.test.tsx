import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordTypeSettingsSnapshot } from "../../lib/types";

const {
  mockRecordTypeSettingsGet,
  mockRecordTypeOptionUpsert,
  mockRecordTypeOptionDelete,
  mockSetStatus,
  mockPushToast,
} = vi.hoisted(() => ({
  mockRecordTypeSettingsGet: vi.fn(),
  mockRecordTypeOptionUpsert: vi.fn(),
  mockRecordTypeOptionDelete: vi.fn(),
  mockSetStatus: vi.fn(),
  mockPushToast: vi.fn(),
}));

vi.mock("../../services/projectMindApi", () => ({
  projectMindApi: {
    recordTypeSettingsGet: mockRecordTypeSettingsGet,
    recordTypeOptionUpsert: mockRecordTypeOptionUpsert,
    recordTypeOptionDelete: mockRecordTypeOptionDelete,
  },
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    setStatus: mockSetStatus,
    pushToast: mockPushToast,
  }),
}));

vi.mock("../rich-editor", () => ({
  RichEditor: ({
    html,
    onSave,
  }: {
    html?: string;
    onSave?: (value: { html: string; text: string; markdown: string }) => Promise<unknown> | unknown;
  }) => {
    const [value, setValue] = useState(html ?? "<p></p>");

    useEffect(() => {
      setValue(html ?? "<p></p>");
    }, [html]);

    return (
      <div>
        <textarea
          aria-label="模板编辑器"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="button"
          onClick={() =>
            onSave?.({
              html: value,
              text: value,
              markdown: value,
            })
          }
        >
          保存模板
        </button>
      </div>
    );
  },
}));

import { RecordTypeSettingsPanel } from "./RecordTypeSettingsPanel";

let snapshot: RecordTypeSettingsSnapshot;

describe("RecordTypeSettingsPanel", () => {
  beforeEach(() => {
    mockRecordTypeSettingsGet.mockReset();
    mockRecordTypeOptionUpsert.mockReset();
    mockRecordTypeOptionDelete.mockReset();
    mockSetStatus.mockReset();
    mockPushToast.mockReset();

    snapshot = {
      recordTypes: [
        {
          id: 1,
          key: "quick_note",
          label: "原始记录",
          colorKey: "slate",
          templateHtml: "<p></p>",
          isDefault: true,
          usageCount: 3,
          createdAt: "",
          updatedAt: "",
        },
        {
          id: 2,
          key: "meeting_minutes",
          label: "会议记录",
          colorKey: "blue",
          templateHtml: "<h2>背景</h2><p></p>",
          isDefault: false,
          usageCount: 0,
          createdAt: "",
          updatedAt: "",
        },
      ],
    };

    mockRecordTypeSettingsGet.mockImplementation(async () => snapshot);
    mockRecordTypeOptionUpsert.mockImplementation(async (input) => {
      const nextRecordType = {
        id: input.id ?? 3,
        key: input.id ? "meeting_minutes" : "research_note",
        label: input.label,
        colorKey: input.colorKey,
        templateHtml: input.templateHtml,
        isDefault: input.isDefault,
        usageCount: input.id ? 0 : 0,
        createdAt: "",
        updatedAt: "",
      };

      snapshot = {
        recordTypes: input.id
          ? snapshot.recordTypes.map((recordType) =>
              recordType.id === input.id ? nextRecordType : recordType,
            )
          : [...snapshot.recordTypes, nextRecordType],
      };

      return nextRecordType;
    });
    mockRecordTypeOptionDelete.mockResolvedValue(undefined);
  });

  it("keeps the create composer collapsed until the user clicks new", async () => {
    const user = userEvent.setup();

    renderPanel();

    expect(screen.queryByPlaceholderText("例如：调研记录 / 复盘记录")).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: "新建" }));
    const composerInput = screen.getByPlaceholderText("例如：调研记录 / 复盘记录");
    const composer = composerInput.parentElement;
    expect(composer).not.toBeNull();
    await user.type(composerInput, "调研记录");
    await user.click(within(composer!).getByRole("button", { name: /颜色/ }));
    await user.click(screen.getByRole("option", { name: "Teal" }));
    await user.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() =>
      expect(mockRecordTypeOptionUpsert.mock.calls[0]?.[0]).toEqual({
        label: "调研记录",
        colorKey: "teal",
        templateHtml: "<p></p>",
        isDefault: false,
      }),
    );

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("例如：调研记录 / 复盘记录")).not.toBeInTheDocument(),
    );
  });

  it("auto-saves selected type meta without rendering save buttons", async () => {
    const user = userEvent.setup();

    renderPanel();

    await user.click(await screen.findByRole("button", { name: /会议记录/ }));
    const labelField = screen.getByDisplayValue("会议记录");

    expect(screen.queryByRole("button", { name: "保存基本信息" })).not.toBeInTheDocument();

    await user.clear(labelField);
    await user.type(labelField, "会议纪要");

    await waitFor(
      () =>
        expect(mockRecordTypeOptionUpsert.mock.calls[0]?.[0]).toEqual({
          id: 2,
          label: "会议纪要",
          colorKey: "blue",
          templateHtml: "<h2>背景</h2><p></p>",
          isDefault: false,
        }),
      { timeout: 1500 },
    );

    await user.click(screen.getByRole("button", { name: /颜色/ }));
    await user.click(screen.getByRole("option", { name: "Rose" }));

    await waitFor(
      () =>
        expect(
          mockRecordTypeOptionUpsert.mock.calls[
            mockRecordTypeOptionUpsert.mock.calls.length - 1
          ]?.[0],
        ).toEqual({
          id: 2,
          label: "会议纪要",
          colorKey: "rose",
          templateHtml: "<h2>背景</h2><p></p>",
          isDefault: false,
        }),
      { timeout: 1500 },
    );
  });

  it("saves template updates for the selected record type", async () => {
    const user = userEvent.setup();

    renderPanel();

    await user.click(await screen.findByRole("button", { name: /会议记录/ }));
    const editor = screen.getByLabelText("模板编辑器");
    await user.clear(editor);
    await user.type(editor, "<h2>新的模板</h2><p></p>");
    await user.click(screen.getByRole("button", { name: "保存模板" }));

    await waitFor(() =>
      expect(mockRecordTypeOptionUpsert.mock.calls[0]?.[0]).toEqual({
        id: 2,
        label: "会议记录",
        colorKey: "blue",
        templateHtml: "<h2>新的模板</h2><p></p>",
        isDefault: false,
      }),
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
      <RecordTypeSettingsPanel open />
    </QueryClientProvider>,
  );
}
