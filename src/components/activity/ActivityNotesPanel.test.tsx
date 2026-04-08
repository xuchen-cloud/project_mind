import { useEffect, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiSuggestionRecord, NoteRecord, RecordTypeSettingsSnapshot } from "../../lib/types";
import { ActivityNotesPanel } from "./ActivityNotesPanel";

const { mockPushToast } = vi.hoisted(() => ({
  mockPushToast: vi.fn(),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../rich-editor", () => ({
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => {
    const normalizedText = value.text.trim();
    const normalizedMarkdown = value.markdown.trim();

    return {
      html: toHtml(normalizedText),
      text: normalizedText,
      markdown: normalizedMarkdown,
    };
  },
  RichEditor: ({
    html,
    onChange,
    onSave,
    placeholder,
  }: {
    html?: string;
    placeholder?: string;
    onChange?: (value: { html: string; text: string; markdown: string }) => void;
    onSave?: (value: { html: string; text: string; markdown: string }) => Promise<unknown> | unknown;
  }) => {
    const [value, setValue] = useState(toPlainText(html ?? ""));

    useEffect(() => {
      setValue(toPlainText(html ?? ""));
    }, [html]);

    return (
      <div>
        <textarea
          aria-label="记录编辑器"
          placeholder={placeholder}
          value={value}
          onChange={(event) => {
            const nextValue = event.target.value;
            setValue(nextValue);
            onChange?.({
              html: toHtml(nextValue),
              text: nextValue,
              markdown: nextValue,
            });
          }}
        />
        <button
          type="button"
          onClick={() =>
            onSave?.({
              html: toHtml(value),
              text: value,
              markdown: value,
            })
          }
        >
          保存编辑器
        </button>
      </div>
    );
  },
}));

const recordTypeSettings: RecordTypeSettingsSnapshot = {
  recordTypes: [
    {
      id: 1,
      key: "quick_note",
      label: "原始记录",
      colorKey: "slate",
      templateHtml: "<p></p>",
      isDefault: true,
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    },
    {
      id: 2,
      key: "meeting_minutes",
      label: "会议记录",
      colorKey: "blue",
      templateHtml:
        "<h2>背景</h2><p></p><h2>讨论要点</h2><p></p><h2>初步结论</h2><p></p><h2>行动项</h2><p></p>",
      isDefault: false,
      usageCount: 0,
      createdAt: "",
      updatedAt: "",
    },
  ],
};

const baseNote: NoteRecord = {
  id: 1,
  projectId: 9,
  activityId: 11,
  noteType: "quick_note",
  title: null,
  contentMarkdown: "客户确认需要补充上下文",
  contentHtml: "客户确认需要补充上下文",
  createdAt: "2026-04-06T08:00:00.000Z",
  updatedAt: "2026-04-06T09:00:00.000Z",
};

describe("ActivityNotesPanel", () => {
  beforeEach(() => {
    mockPushToast.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("starts empty and creates the first record after choosing a type from the new menu", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      contentMarkdown: "Captured detail",
      contentHtml: "<p>Captured detail</p>",
    }));

    renderPanel({
      notes: [],
      onUpsertNote,
    });

    expect(screen.getByText("还没有记录")).toBeInTheDocument();
    expect(screen.queryByLabelText("记录编辑器")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));
    await user.type(screen.getByLabelText("记录编辑器"), "Captured detail");
    await user.click(screen.getByRole("button", { name: "保存编辑器" }));

    expect(onUpsertNote).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      noteType: "quick_note",
      title: "记录",
      markdown: "Captured detail",
      html: "<p>Captured detail</p>",
    });
  });

  it("trims boundary blank lines and spaces before saving a note", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      contentMarkdown: "Captured detail",
      contentHtml: "<p>Captured detail</p>",
    }));

    renderPanel({
      notes: [],
      onUpsertNote,
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));
    await user.type(screen.getByLabelText("记录编辑器"), "  Captured detail  ");
    await user.click(screen.getByRole("button", { name: "保存编辑器" }));

    expect(onUpsertNote).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      noteType: "quick_note",
      title: "记录",
      markdown: "Captured detail",
      html: "<p>Captured detail</p>",
    });
  });

  it("shows record results, toggles preview, and only switches editor after clicking edit", async () => {
    const user = userEvent.setup();

    renderPanel({
      notes: [
        baseNote,
        {
          ...baseNote,
          id: 2,
          noteType: "meeting_minutes",
          title: "会议纪要",
          contentMarkdown: "确认本周五前补齐材料",
          contentHtml: "<p>确认本周五前补齐材料</p>",
          updatedAt: "2026-04-06T10:00:00.000Z",
        },
      ],
    });

    expect(screen.getByText("会议记录")).toBeInTheDocument();
    expect(screen.getByText("其他记录")).toBeInTheDocument();
    expect(screen.getByLabelText("记录编辑器")).toHaveValue("确认本周五前补齐材料");

    const recordToggle = screen.getByRole("button", { name: /原始记录/ });

    await user.click(recordToggle);
    expect(screen.getByLabelText("记录编辑器")).toHaveValue("确认本周五前补齐材料");

    await user.click(screen.getByRole("button", { name: /原始记录/ }));
    await user.click(screen.getByRole("button", { name: "编辑这条记录" }));
    expect(screen.getByLabelText("记录编辑器")).toHaveValue("客户确认需要补充上下文");
  });

  it("creates a meeting-note draft from the new menu and saves it", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      noteType: "meeting_minutes",
      title: "记录",
      contentMarkdown: "客户确认需要补充上下文",
      contentHtml: "<p>客户确认需要补充上下文</p>",
      updatedAt: "2026-04-06T10:30:00.000Z",
    }));

    renderPanel({
      notes: [baseNote],
      onUpsertNote,
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "会议记录" }));
    await user.type(screen.getByLabelText("记录编辑器"), "客户确认需要补充上下文");
    await user.click(screen.getByRole("button", { name: "保存编辑器" }));

    await waitFor(() =>
      expect(onUpsertNote).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        noteType: "meeting_minutes",
        title: "记录",
        markdown: "背景\n讨论要点\n初步结论\n行动项客户确认需要补充上下文",
        html: "<p>背景\n讨论要点\n初步结论\n行动项客户确认需要补充上下文</p>",
      }),
    );
  });

  it("does not replace a non-empty draft when creating another record type", async () => {
    const user = userEvent.setup();

    renderPanel({
      notes: [baseNote],
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "会议记录" }));
    await user.type(screen.getByLabelText("记录编辑器"), "客户确认需要补充上下文");

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));

    expect(mockPushToast).toHaveBeenCalledWith(
      expect.objectContaining({
        tone: "info",
        title: "请先保存当前草稿",
      }),
    );
    expect(screen.getByLabelText("记录编辑器")).toHaveValue(
      "背景\n讨论要点\n初步结论\n行动项客户确认需要补充上下文",
    );
  });

  it("opens an AI confirmation dialog from a created record and writes suggestions after confirm", async () => {
    const user = userEvent.setup();
    const savedNote = {
      ...baseNote,
      id: 7,
      title: "会议纪要",
      contentMarkdown: "确认预算范围，需要财务补充拆分明细",
      contentHtml: "<p>确认预算范围，需要财务补充拆分明细</p>",
    };
    const suggestions: AiSuggestionRecord[] = [
      {
        id: 31,
        projectId: 9,
        activityId: 11,
        noteId: 7,
        suggestionType: "activity_title",
        title: "活动标题建议",
        preview: "预算讨论 - 阶段整理",
        payload: { proposedTitle: "预算讨论 - 阶段整理" },
        status: "pending",
        createdAt: "2026-04-06T10:10:00.000Z",
      },
      {
        id: 32,
        projectId: 9,
        activityId: 11,
        noteId: 7,
        suggestionType: "conclusion",
        title: "结论候选",
        preview: "已确认预算范围和审批边界",
        payload: { content: "已确认预算范围和审批边界" },
        status: "pending",
        createdAt: "2026-04-06T10:10:00.000Z",
      },
      {
        id: 33,
        projectId: 9,
        activityId: 11,
        noteId: 7,
        suggestionType: "todo",
        title: "待办候选",
        preview: "财务补充预算拆分明细",
        payload: { content: "财务补充预算拆分明细" },
        status: "pending",
        createdAt: "2026-04-06T10:10:00.000Z",
      },
      {
        id: 34,
        projectId: 9,
        activityId: 11,
        noteId: 7,
        suggestionType: "todo",
        title: "待办候选",
        preview: "下次会议前同步审批时间表",
        payload: { content: "下次会议前同步审批时间表" },
        status: "pending",
        createdAt: "2026-04-06T10:10:00.000Z",
      },
    ];
    const onUpsertNote = vi.fn(async () => savedNote);
    const onGenerateAiSuggestions = vi.fn(async () => suggestions);
    const onAcceptAiSuggestion = vi.fn(async (suggestionId: number) => ({
      suggestion: suggestions.find((item) => item.id === suggestionId) ?? suggestions[1],
      entityKind: suggestionId === 32 ? "conclusion" : "todo",
      entityId: suggestionId + 100,
    }));

    renderPanel({
      notes: [],
      onUpsertNote,
      aiEnabled: true,
      onGenerateAiSuggestions,
      onAcceptAiSuggestion,
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));
    await user.type(screen.getByLabelText("记录编辑器"), "确认预算范围，需要财务补充拆分明细");
    await user.click(screen.getByRole("button", { name: "AI 提炼" }));

    await waitFor(() =>
      expect(onUpsertNote).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        noteType: "quick_note",
        title: "记录",
        markdown: "确认预算范围，需要财务补充拆分明细",
        html: "<p>确认预算范围，需要财务补充拆分明细</p>",
      }),
    );
    expect(onGenerateAiSuggestions).toHaveBeenCalledWith(7);

    expect(await screen.findByText("确认 AI 提炼")).toBeInTheDocument();
    expect(screen.getByText("已确认预算范围和审批边界")).toBeInTheDocument();
    expect(screen.getByText("财务补充预算拆分明细")).toBeInTheDocument();
    expect(screen.getByText("下次会议前同步审批时间表")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认并写入（3项）" }));

    await waitFor(() => expect(onAcceptAiSuggestion).toHaveBeenCalledTimes(3));
    expect(onAcceptAiSuggestion).toHaveBeenNthCalledWith(1, 32);
    expect(onAcceptAiSuggestion).toHaveBeenNthCalledWith(2, 33);
    expect(onAcceptAiSuggestion).toHaveBeenNthCalledWith(3, 34);
  });
});

function renderPanel({
  notes = [],
  onUpsertNote = vi.fn(async () => baseNote) as (input: import("../../lib/types").NoteUpsertInput) => Promise<NoteRecord>,
  aiEnabled = false,
  onGenerateAiSuggestions,
  onAcceptAiSuggestion,
}: {
  notes?: NoteRecord[];
  onUpsertNote?: (input: import("../../lib/types").NoteUpsertInput) => Promise<NoteRecord>;
  aiEnabled?: boolean;
  onGenerateAiSuggestions?: (noteId: number) => Promise<AiSuggestionRecord[]>;
  onAcceptAiSuggestion?: (suggestionId: number) => Promise<import("../../lib/types").AcceptedSuggestionResult>;
}) {
  return render(
    <ActivityNotesPanel
      projectId={9}
      activityId={11}
      notes={notes}
      recordTypeSettings={recordTypeSettings}
      saving={false}
      onUpsertNote={onUpsertNote}
      onImportDocument={vi.fn()}
      aiEnabled={aiEnabled}
      onGenerateAiSuggestions={onGenerateAiSuggestions}
      onAcceptAiSuggestion={onAcceptAiSuggestion}
    />,
  );
}

function toPlainText(html: string) {
  return html
    .replace(/<\/(h1|h2|h3|p|li)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function toHtml(text: string) {
  const normalized = text.trim();
  return normalized.length > 0 ? `<p>${normalized}</p>` : "<p></p>";
}
