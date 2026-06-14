import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  fireEvent,
  render as baseRender,
  screen,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceRecord } from "../../lib/types";
import { WorkspaceOverviewHistory } from "./WorkspaceOverviewHistory";

function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>
      {ui}
    </QueryClientProvider>,
  );
}

vi.mock("../rich-editor", () => ({
  getRenderableRichTextHtml: ({ html, markdown }: { html?: string; markdown?: string }) =>
    html ?? (markdown ? `<p>${markdown}</p>` : ""),
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => value,
  RichTextViewer: ({ html }: { html?: string }) => <div>{toPlainText(html ?? "")}</div>,
  RichEditor: ({
    html,
    autoFocus,
    readOnly,
    placeholder,
    onChange,
    onSave,
  }: {
    html?: string;
    autoFocus?: boolean | { x: number; y: number; mode?: "viewport" | "content-relative" };
    readOnly?: boolean;
    placeholder?: string;
    onChange?: (value: { html: string; text: string; markdown: string }) => void;
    onSave?: (value: { html: string; text: string; markdown: string }) => Promise<unknown> | unknown;
  }) => {
    const [value, setValue] = useState(toPlainText(html ?? ""));
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
      setValue(toPlainText(html ?? ""));
    }, [html]);

    useEffect(() => {
      if (autoFocus) {
        textareaRef.current?.focus();
      }
    }, [autoFocus]);

    if (readOnly) {
      return <div>{value}</div>;
    }

    return (
      <textarea
        ref={textareaRef}
        aria-label="工作区记录编辑器"
        data-autofocus-x={typeof autoFocus === "object" ? autoFocus.x : undefined}
        data-autofocus-y={typeof autoFocus === "object" ? autoFocus.y : undefined}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          const nextValue = event.target.value;
          setValue(nextValue);
          onChange?.(buildMockRichValue(nextValue));
        }}
        onBlur={() => {
          void onSave?.(buildMockRichValue(value));
        }}
      />
    );
  },
}));

const baseNote: WorkspaceRecord = {
  id: 7,
  title: "已有记录",
  contentMarkdown: "先记一条背景",
  contentHtml: "<p>先记一条背景</p>",
  tags: [],
  createdAt: "2026-04-06T08:00:00.000Z",
  updatedAt: "2026-04-06T09:00:00.000Z",
};

describe("WorkspaceOverviewHistory", () => {
  it("uses focus only for positioning and does not auto-enter editing", () => {
    render(
      <WorkspaceOverviewHistory
        notes={[baseNote]}
        focusId="record-7"
        composeRecord={false}
        pageWidthMode="adaptive"
        availableTags={[]}
        onCreateRecord={vi.fn()}
        onUpdateRecord={vi.fn()}
        onDeleteRecord={vi.fn()}
        onCloseCompose={vi.fn()}
        contactMentionOptions={{}}
        onOpenInternalReference={vi.fn()}
      />,
    );

    const record = document.getElementById("record-7");
    expect(record).toBeInTheDocument();
    expect(record).toHaveClass("scroll-mt-6");
    expect(screen.queryByLabelText("记录标题")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("工作区记录编辑器")).not.toBeInTheDocument();
  });

  it("enters editing only after clicking the record surface", () => {
    render(
      <WorkspaceOverviewHistory
        notes={[baseNote]}
        focusId="record-7"
        composeRecord={false}
        pageWidthMode="adaptive"
        availableTags={[]}
        onCreateRecord={vi.fn()}
        onUpdateRecord={vi.fn()}
        onDeleteRecord={vi.fn()}
        onCloseCompose={vi.fn()}
        contactMentionOptions={{}}
        onOpenInternalReference={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: /已有记录/ }), {
      button: 0,
      nativeEvent: { offsetX: 18, offsetY: 26 },
    });

    const editor = screen.getByLabelText("工作区记录编辑器");
    expect(editor).toBeInTheDocument();
    expect(document.getElementById("record-7")).toHaveClass("project-history-record--editing");
  });

  it("deletes a record from the context menu", async () => {
    const onDeleteRecord = vi.fn();

    render(
      <WorkspaceOverviewHistory
        notes={[baseNote]}
        focusId={null}
        composeRecord={false}
        pageWidthMode="adaptive"
        availableTags={[]}
        onCreateRecord={vi.fn()}
        onUpdateRecord={vi.fn()}
        onDeleteRecord={onDeleteRecord}
        onCloseCompose={vi.fn()}
        contactMentionOptions={{}}
        onOpenInternalReference={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: /已有记录/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /删除/ }));

    expect(onDeleteRecord).toHaveBeenCalledWith(7);
  });
});

function buildMockRichValue(value: string) {
  const text = value.trim();
  return {
    html: toHtml(text),
    text,
    markdown: text,
  };
}

function toPlainText(html: string) {
  return html.replace(/<[^>]+>/g, "").trim();
}

function toHtml(value: string) {
  return value.trim().length > 0 ? `<p>${value.trim()}</p>` : "<p></p>";
}
