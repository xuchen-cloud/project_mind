import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  fireEvent,
  render as baseRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
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

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="current path">{location.pathname}</output>;
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
    return <div>{renderMockViewerContent(props.html ?? "")}</div>;
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

  it("defers the record viewer in browse mode while preserving eager nearby images", () => {
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
    expect(recordViewerProps?.deferUntilVisible).toBe(true);
    expect(recordViewerProps?.eagerManagedImages).toBe(true);
  });

  it("does not show the expand button when record content fits the default height", async () => {
    const scrollHeightSpy = mockCollapsibleScrollHeight(() => 180);

    try {
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

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "展开全部" })).not.toBeInTheDocument();
      });
    } finally {
      scrollHeightSpy.mockRestore();
    }
  });

  it("keeps long record summaries compact without mounting an editor", async () => {
    const scrollHeightSpy = mockCollapsibleScrollHeight(() => 460);

    try {
      render(
        <WorkspaceOverviewHistory
          notes={[
            {
              ...baseNote,
              contentMarkdown: "很长的记录",
              contentHtml: "<p>很长的记录</p>",
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

      expect(screen.getByText("很长的记录")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "展开全部" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("工作区记录编辑器")).not.toBeInTheDocument();
    } finally {
      scrollHeightSpy.mockRestore();
    }
  });

  it("keeps the card compact when its thumbnail finishes loading", async () => {
    let imageLoaded = false;
    const scrollHeightSpy = mockCollapsibleScrollHeight((element) =>
      element.querySelector("img") && imageLoaded ? 460 : 180,
    );

    try {
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

      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "展开全部" })).not.toBeInTheDocument();
      });

      imageLoaded = true;
      fireEvent.load(screen.getByAltText("截图"));

      expect(screen.queryByRole("button", { name: "展开全部" })).not.toBeInTheDocument();
    } finally {
      scrollHeightSpy.mockRestore();
    }
  });

  it("does not reserve an empty tag row when a workspace record has no tags", () => {
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

    expect(screen.queryByRole("button", { name: "添加标签" })).not.toBeInTheDocument();
    expect(
      document.querySelector("#record-7 .project-history-record__tag-row"),
    ).not.toBeInTheDocument();
  });




  it("opens the workspace record focus page from a single card click", async () => {
    render(
      <>
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
        />
        <LocationProbe />
      </>,
    );

    const recordSurface = screen.getByRole("button", { name: /已有记录/ });
    fireEvent.click(recordSurface);
    expect(screen.queryByLabelText("工作区记录编辑器")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByLabelText("current path")).toHaveTextContent("/workspace/records/7");
    });
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

function renderMockViewerContent(html: string) {
  const text = toPlainText(html);

  if (/<img\b/i.test(html)) {
    return (
      <>
        <span>{text}</span>
        <img src="mock-image.png" alt="截图" />
      </>
    );
  }

  return text;
}

function mockCollapsibleScrollHeight(getHeight: (element: HTMLElement) => number) {
  return vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockImplementation(function getScrollHeight(this: HTMLElement) {
      if (this.classList.contains("project-history-record__collapsible")) {
        return getHeight(this);
      }

      return 0;
    });
}
