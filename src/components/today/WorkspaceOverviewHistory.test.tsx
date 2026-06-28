import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  fireEvent,
  render as baseRender,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceRecord } from "../../lib/types";
import { WorkspaceOverviewHistory } from "./WorkspaceOverviewHistory";

const richEditorMocks = vi.hoisted(() => ({
  richTextViewerProps: [] as Array<{
    html?: string;
    deferUntilVisible?: boolean;
    active?: boolean;
    eagerManagedImages?: boolean;
  }>,
}));

function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

vi.mock("../rich-editor", () => ({
  getRenderableRichTextHtml: ({ html, markdown }: { html?: string; markdown?: string }) =>
    html ?? (markdown ? `<p>${markdown}</p>` : ""),
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => value,
  RichTextViewer: (props: {
    html?: string;
    deferUntilVisible?: boolean;
    active?: boolean;
    eagerManagedImages?: boolean;
  }) => {
    richEditorMocks.richTextViewerProps.push(props);
    return <div>{toPlainText(props.html ?? "")}</div>;
  },
  RichEditor: ({
    html,
    autoFocus,
    readOnly,
    placeholder,
    controllerRef,
    onChange,
    onSave,
  }: {
    html?: string;
    autoFocus?: boolean | { x: number; y: number; mode?: "viewport" | "content-relative" };
    readOnly?: boolean;
    placeholder?: string;
    controllerRef?: { current: { getValue: () => { html: string; text: string; markdown: string } } | null };
    onChange?: (value: { html: string; text: string; markdown: string }) => void;
    onSave?: (value: { html: string; text: string; markdown: string }) => Promise<unknown> | unknown;
  }) => {
    const [value, setValue] = useState(toPlainText(html ?? ""));
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const valueRef = useRef(value);

    valueRef.current = value;

    useEffect(() => {
      setValue(toPlainText(html ?? ""));
    }, [html]);

    useEffect(() => {
      if (autoFocus) {
        textareaRef.current?.focus();
      }
    }, [autoFocus]);

    useEffect(() => {
      if (!controllerRef) {
        return;
      }

      controllerRef.current = {
        getValue: () => buildMockRichValue(valueRef.current),
      };

      return () => {
        controllerRef.current = null;
      };
    }, [controllerRef]);

    if (readOnly) {
      return <div>{value}</div>;
    }

    return (
      <textarea
        ref={textareaRef}
        aria-label="工作区记录编辑器"
        className="rich-editor__surface"
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
  beforeEach(() => {
    richEditorMocks.richTextViewerProps.length = 0;
  });

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

  it("does not defer the record viewer in browse mode so images can render immediately", () => {
    render(
      <WorkspaceOverviewHistory
        notes={[
          {
            ...baseNote,
            contentHtml: '<p>图片记录</p><img src="asset://workspace-image.png" alt="截图">',
          },
        ]}
        focusId={null}
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

    const recordViewerProps = richEditorMocks.richTextViewerProps.find((props) =>
      props.html?.includes("asset://workspace-image.png"),
    );

    expect(recordViewerProps).toBeDefined();
    expect(recordViewerProps?.deferUntilVisible).toBeUndefined();
    expect(recordViewerProps?.eagerManagedImages).toBe(true);
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

  it("opens the record context menu from an edited record header but not the editor body", async () => {
    render(
      <WorkspaceOverviewHistory
        notes={[baseNote]}
        focusId={null}
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
    });

    fireEvent.contextMenu(screen.getByPlaceholderText("记录标题"), {
      clientX: 52,
      clientY: 64,
    });
    expect(screen.getByRole("menu", { name: "记录操作" })).toBeInTheDocument();

    fireEvent.scroll(window);
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "记录操作" })).not.toBeInTheDocument();
    });

    fireEvent.contextMenu(screen.getByLabelText("工作区记录编辑器"), {
      clientX: 52,
      clientY: 96,
    });
    expect(screen.queryByRole("menu", { name: "记录操作" })).not.toBeInTheDocument();
  });

  it("closes the record context menu when the page scrolls", async () => {
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

    fireEvent.contextMenu(document.getElementById("record-7") as HTMLElement, {
      clientX: 44,
      clientY: 88,
    });
    expect(screen.getByRole("menu", { name: "记录操作" })).toBeInTheDocument();

    fireEvent.scroll(window);
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "记录操作" })).not.toBeInTheDocument();
    });
  });

  it("saves and exits editing with Ctrl+Enter", async () => {
    const onUpdateRecord = vi.fn(async () => undefined);

    render(
      <WorkspaceOverviewHistory
        notes={[baseNote]}
        focusId={null}
        composeRecord={false}
        pageWidthMode="adaptive"
        availableTags={[]}
        onCreateRecord={vi.fn()}
        onUpdateRecord={onUpdateRecord}
        onDeleteRecord={vi.fn()}
        onCloseCompose={vi.fn()}
        contactMentionOptions={{}}
        onOpenInternalReference={vi.fn()}
      />,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: /已有记录/ }), {
      button: 0,
    });

    const editor = screen.getByLabelText("工作区记录编辑器");
    fireEvent.change(editor, { target: { value: "更新后的记录" } });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(onUpdateRecord).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        expect.objectContaining({
          markdown: "更新后的记录",
          html: "<p>更新后的记录</p>",
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("工作区记录编辑器")).not.toBeInTheDocument();
    });
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
