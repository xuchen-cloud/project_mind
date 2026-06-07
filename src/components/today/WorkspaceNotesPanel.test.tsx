import { useEffect, useRef, useState, type ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render as baseRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceNoteRecord } from "../../lib/types";
import { WorkspaceNotesPanel } from "./WorkspaceNotesPanel";

function render(ui: ReactElement) {
  return baseRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );
}

const { mockPushToast } = vi.hoisted(() => ({
  mockPushToast: vi.fn(),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: mockPushToast,
  }),
}));

vi.mock("../rich-editor", () => ({
  RICH_EDITOR_FOCUS_REQUEST_EVENT: "project-mind-rich-editor-focus-request",
  normalizeRichEditorValue: (value: { html: string; text: string; markdown: string }) => {
    const normalizedText = value.text.trim();
    const normalizedMarkdown = value.markdown.trim();
    const normalizedHtml = value.html.trim();

    return {
      html: normalizedHtml.length > 0 ? normalizedHtml : toHtml(normalizedText),
      text: normalizedText,
      markdown: normalizedMarkdown,
    };
  },
  RichEditor: ({
    html,
    autoFocus,
    autosave,
    shouldPersistOnBlur,
    onChange,
    onSave,
    onBlurPersisted,
    onModEnter,
    onPersistStateChange,
    placeholder,
  }: {
    html?: string;
    autoFocus?: boolean;
    autosave?:
      | boolean
      | {
          delay?: number;
          onChange?: boolean;
          onBlur?: boolean;
          onWindowBlur?: boolean;
          onVisibilityChange?: boolean;
        };
    shouldPersistOnBlur?: (relatedTarget: EventTarget | null) => boolean;
    placeholder?: string;
    onChange?: (value: { html: string; text: string; markdown: string }) => void;
    onSave?: (value: { html: string; text: string; markdown: string }) => Promise<unknown> | unknown;
    onBlurPersisted?: (result: unknown) => void;
    onModEnter?: () => Promise<unknown> | unknown;
    onPersistStateChange?: (state: "idle" | "dirty" | "saving" | "saved" | "error") => void;
  }) => {
    const [value, setValue] = useState(toPlainText(html ?? ""));
    const [persistState, setPersistState] = useState<"idle" | "dirty" | "saving" | "saved">(
      html && toPlainText(html).trim().length > 0 ? "saved" : "idle",
    );
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
      setValue(toPlainText(html ?? ""));
      setPersistState(html && toPlainText(html).trim().length > 0 ? "saved" : "idle");
    }, [html]);

    useEffect(() => {
      if (autoFocus) {
        textareaRef.current?.focus();
      }
    }, [autoFocus]);

    useEffect(() => {
      onPersistStateChange?.(persistState);
    }, [onPersistStateChange, persistState]);

    const save = async () => {
      setPersistState("saving");

      try {
        return await onSave?.(buildMockRichValue(value));
      } finally {
        setPersistState(value.trim().length > 0 ? "saved" : "idle");
      }
    };

    return (
      <textarea
        ref={textareaRef}
        aria-label="工作区记录编辑器"
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          const nextValue = event.target.value;
          setValue(nextValue);
          setPersistState("dirty");
          onChange?.(buildMockRichValue(nextValue));
        }}
        onBlur={async (event) => {
          const relatedTarget = event.relatedTarget;
          const saveOnBlur =
            typeof autosave === "object" ? (autosave.onBlur ?? true) : Boolean(autosave);

          if (!saveOnBlur || (shouldPersistOnBlur && !shouldPersistOnBlur(relatedTarget))) {
            return;
          }

          const result = await save();
          onBlurPersisted?.(result);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void onModEnter?.();
          }
        }}
      />
    );
  },
}));

const baseNote: WorkspaceNoteRecord = {
  id: 7,
  title: "已有记录",
  contentMarkdown: "先记一条背景",
  contentHtml: "<p>先记一条背景</p>",
  createdAt: "2026-04-06T08:00:00.000Z",
  updatedAt: "2026-04-06T09:00:00.000Z",
};

describe("WorkspaceNotesPanel", () => {
  beforeEach(() => {
    mockPushToast.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows an empty state when there are no workspace notes", () => {
    render(
      <WorkspaceNotesPanel
        notes={[]}
        onUpsertNote={vi.fn()}
        onDeleteNote={vi.fn()}
      />,
    );

    expect(screen.getByText("还没有工作区记录。")).toBeInTheDocument();
  });

  it("creates the first workspace note and autosaves on blur", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      id: 9,
      title: "工作台判断",
      contentMarkdown: "今天先盯住预算和法务",
      contentHtml: "<p>今天先盯住预算和法务</p>",
      updatedAt: "2026-04-06T10:00:00.000Z",
    }));

    render(
      <>
        <WorkspaceNotesPanel
          notes={[]}
          onUpsertNote={onUpsertNote}
          onDeleteNote={vi.fn()}
        />
        <button type="button">outside</button>
      </>,
    );

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.type(screen.getByLabelText("工作区记录标题"), "工作台判断");
    await user.type(screen.getByLabelText("工作区记录编辑器"), "今天先盯住预算和法务");
    await user.click(screen.getByRole("button", { name: "outside" }));

    await waitFor(() =>
      expect(onUpsertNote).toHaveBeenCalledWith({
        title: "工作台判断",
        markdown: "今天先盯住预算和法务",
        html: "<p>今天先盯住预算和法务</p>",
      }),
    );
    expect(document.getElementById("workspace-note-9")).toBeInTheDocument();
    expect(screen.getByDisplayValue("工作台判断")).toBeInTheDocument();
  });

  it("expands a note preview and enters edit mode from the preview", async () => {
    render(
      <WorkspaceNotesPanel
        notes={[baseNote]}
        onUpsertNote={vi.fn(async () => baseNote)}
        onDeleteNote={vi.fn()}
      />,
    );

    expect(screen.getByText("先记一条背景")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText("编辑工作区记录：已有记录"), { button: 0 });

    expect(screen.getByLabelText("工作区记录标题")).toBeInTheDocument();
    expect(screen.getByLabelText("工作区记录编辑器")).toBeInTheDocument();
  });

  it("deletes a workspace note from the context menu", async () => {
    const user = userEvent.setup();
    const onDeleteNote = vi.fn();

    render(
      <WorkspaceNotesPanel
        notes={[baseNote]}
        onUpsertNote={vi.fn(async () => baseNote)}
        onDeleteNote={onDeleteNote}
      />,
    );

    fireEvent.contextMenu(document.getElementById("workspace-note-7") as HTMLElement, {
      clientX: 160,
      clientY: 80,
    });

    await user.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(onDeleteNote).toHaveBeenCalledWith(7);
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
