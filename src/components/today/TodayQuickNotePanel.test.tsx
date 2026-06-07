import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as baseRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ProjectListItem, WorkspaceNoteRecord } from "../../lib/types";

function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

vi.mock("../rich-editor", () => ({
  RICH_EDITOR_FOCUS_REQUEST_EVENT: "project-mind-rich-editor-focus-request",
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => {
    const normalizedText = value.text.trim();
    const normalizedMarkdown = value.markdown.trim();

    return {
      html: normalizedText ? `<p>${normalizedText}</p>` : "",
      text: normalizedText,
      markdown: normalizedMarkdown,
    };
  },
  RichEditor: ({
    html = "",
    placeholder,
    onChange,
    selectionActions = [],
  }: {
    html?: string;
    placeholder?: string;
    onChange?: (value: { html: string; text: string; markdown: string }) => void;
    selectionActions?: Array<{
      key: string;
      label: string;
      disabled?: boolean;
      onSelect: (payload: { text: string; markdown: string; html: string }) => void;
    }>;
  }) => (
    <div>
      <textarea
        aria-label={
          placeholder === "记下今天最需要先抓住的背景、判断、临时结论或提醒。"
            ? "今日快记编辑器"
            : "富文本编辑器"
        }
        placeholder={placeholder}
        value={html.replace(/<[^>]+>/g, "")}
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange?.({
            html: nextValue ? `<p>${nextValue}</p>` : "",
            text: nextValue,
            markdown: nextValue,
          });
        }}
      />
      {selectionActions.map((action) => (
        <button
          key={action.key}
          type="button"
          disabled={action.disabled}
          onClick={() =>
            action.onSelect({
              text: "整理供应商方案\n补充关键风险",
              markdown: "整理供应商方案\n\n补充关键风险",
              html: "<p>整理供应商方案</p><p>补充关键风险</p>",
            })
          }
        >
          {action.label}
        </button>
      ))}
    </div>
  ),
}));

import { TodayQuickNotePanel } from "./TodayQuickNotePanel";

describe("TodayQuickNotePanel", () => {
  it("saves the singleton note on blur", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => buildNote());

    render(<TodayQuickNotePanel note={buildNote()} onUpsertNote={onUpsertNote} />);

    const editor = screen.getByLabelText("今日快记编辑器");
    await user.clear(editor);
    await user.type(editor, "更新后的今日快记");
    fireEvent.blur(editor);

    expect(onUpsertNote).toHaveBeenCalledWith({
      markdown: "更新后的今日快记",
      html: "<p>更新后的今日快记</p>",
    });
  });

  it("saves the selected quick note content as an activity", async () => {
    const user = userEvent.setup();
    const onSaveSelectionAsActivity = vi.fn(async () => undefined);

    render(
      <TodayQuickNotePanel
        note={buildNote()}
        onUpsertNote={vi.fn(async () => buildNote())}
        projects={[buildProject({ id: 11, name: "Alpha" })]}
        onSaveSelectionAsActivity={onSaveSelectionAsActivity}
      />,
    );

    await user.click(screen.getByRole("button", { name: "选区另存为活动" }));
    expect(screen.getByRole("dialog", { name: "选区另存为活动" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("整理供应商方案")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认" }));

    expect(onSaveSelectionAsActivity).toHaveBeenCalledWith({
      projectId: 11,
      title: "整理供应商方案",
      selection: {
        text: "整理供应商方案\n补充关键风险",
        markdown: "整理供应商方案\n\n补充关键风险",
        html: "<p>整理供应商方案</p><p>补充关键风险</p>",
      },
    });
  });

  it("appends the selected quick note content to an existing project note", async () => {
    const user = userEvent.setup();
    const onAppendSelectionToProjectNote = vi.fn(async () => undefined);

    render(
      <TodayQuickNotePanel
        note={buildNote()}
        onUpsertNote={vi.fn(async () => buildNote())}
        projects={[buildProject({ id: 11, name: "Alpha" }), buildProject({ id: 12, name: "Beta" })]}
        onAppendSelectionToProjectNote={onAppendSelectionToProjectNote}
      />,
    );

    await user.click(screen.getByRole("button", { name: "追加到项目默认笔记" }));
    await user.selectOptions(screen.getByLabelText("目标项目"), "12");
    await user.click(screen.getByRole("button", { name: "确认" }));

    expect(onAppendSelectionToProjectNote).toHaveBeenCalledWith({
      projectId: 12,
      selection: {
        text: "整理供应商方案\n补充关键风险",
        markdown: "整理供应商方案\n\n补充关键风险",
        html: "<p>整理供应商方案</p><p>补充关键风险</p>",
      },
    });
  });
});

function buildNote(): WorkspaceNoteRecord {
  return {
    id: 7,
    title: null,
    contentMarkdown: "已有今日快记",
    contentHtml: "<p>已有今日快记</p>",
    createdAt: "2026-04-17T08:00:00.000Z",
    updatedAt: "2026-04-17T08:30:00.000Z",
  };
}

function buildProject(overrides: Partial<ProjectListItem> = {}): ProjectListItem {
  const { kind = "normal", ...rest } = overrides;
  return {
    id: 11,
    name: "Alpha",
    kind,
    status: "active",
    rootPath: "/tmp/alpha",
    summary: "",
    summaryMarkdown: "",
    summaryHtml: "",
    isArchived: false,
    createdAt: "2026-04-17T08:00:00.000Z",
    updatedAt: "2026-04-17T08:30:00.000Z",
    activityCount: 0,
    unorganizedCount: 0,
    openTodoCount: 0,
    ...rest,
  };
}
