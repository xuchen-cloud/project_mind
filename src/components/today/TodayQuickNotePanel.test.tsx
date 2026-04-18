import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceNoteRecord } from "../../lib/types";

vi.mock("../rich-editor", () => ({
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
  }: {
    html?: string;
    placeholder?: string;
    onChange?: (value: { html: string; text: string; markdown: string }) => void;
  }) => (
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
