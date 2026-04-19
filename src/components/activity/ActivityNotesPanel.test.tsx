import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AiSuggestionRecord,
  NoteRecord,
  RecordTypeSettingsSnapshot,
} from "../../lib/types";
import {
  createUiStoreState,
  useUiStore,
} from "../../state/ui-store";
import { ActivityNotesPanel } from "./ActivityNotesPanel";
import { resetActivityNoteSessions } from "./note-session";

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
  normalizeRichEditorValue: (value: {
    html: string;
    text: string;
    markdown: string;
  }) => {
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
    renderToolbarExtras,
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
    onChange?: (value: {
      html: string;
      text: string;
      markdown: string;
    }) => void;
    onSave?: (value: {
      html: string;
      text: string;
      markdown: string;
    }) => Promise<unknown> | unknown;
    onBlurPersisted?: (result: unknown) => void;
    onModEnter?: () => Promise<unknown> | unknown;
    onPersistStateChange?: (
      state: "idle" | "dirty" | "saving" | "saved" | "error",
    ) => void;
    renderToolbarExtras?: (context: {
      persistState: "idle" | "dirty" | "saving" | "saved" | "error";
      save: (_options?: { force?: boolean }) => Promise<unknown> | unknown;
    }) => ReactNode;
  }) => {
    const [value, setValue] = useState(toMockEditorValue(html ?? ""));
    const [persistState, setPersistState] = useState<
      "idle" | "dirty" | "saving" | "saved"
    >(html && toPlainText(html).trim().length > 0 ? "saved" : "idle");
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
      setValue(toMockEditorValue(html ?? ""));
      setPersistState(
        html && toPlainText(html).trim().length > 0 ? "saved" : "idle",
      );
    }, [html]);

    useEffect(() => {
      if (autoFocus) {
        textareaRef.current?.focus();
      }
    }, [autoFocus]);

    useEffect(() => {
      onPersistStateChange?.(persistState);
    }, [onPersistStateChange, persistState]);

    const save = async (_options?: { force?: boolean }) => {
      setPersistState("saving");

      try {
        return await onSave?.(buildMockRichValue(value));
      } finally {
        setPersistState(value.trim().length > 0 ? "saved" : "idle");
      }
    };

    return (
      <div>
        <div>{renderToolbarExtras?.({ persistState, save })}</div>
        <textarea
          ref={textareaRef}
          aria-label="记录编辑器"
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
              typeof autosave === "object"
                ? (autosave.onBlur ?? true)
                : Boolean(autosave);

            if (
              !saveOnBlur ||
              (shouldPersistOnBlur && !shouldPersistOnBlur(relatedTarget))
            ) {
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
    useUiStore.persist.clearStorage();
    useUiStore.setState(createUiStoreState());
    resetActivityNoteSessions();
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

    expect(screen.getByText("还没有记录。")).toBeInTheDocument();
    expect(screen.queryByLabelText("记录编辑器")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));
    await user.type(screen.getByLabelText("记录编辑器"), "Captured detail");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onUpsertNote).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      noteType: "quick_note",
      title: "Captured detail",
      markdown: "Captured detail",
      html: "<p>Captured detail</p>",
    });
    await waitFor(() =>
      expect(screen.queryByLabelText("记录编辑器")).not.toBeInTheDocument(),
    );
  });

  it("creates a default note draft when clicking the empty state", async () => {
    const user = userEvent.setup();

    renderPanel({
      notes: [],
    });

    await user.click(screen.getByRole("button", { name: "按默认记录类型新建记录" }));

    expect(screen.getByLabelText("记录编辑器")).toBeInTheDocument();
    expect(screen.getByLabelText("记录编辑器")).toHaveFocus();
    expect(screen.getByLabelText("记录标题")).toHaveValue("");
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
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onUpsertNote).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      noteType: "quick_note",
      title: "Captured detail",
      markdown: "Captured detail",
      html: "<p>Captured detail</p>",
    });
  });

  it("persists markdown instead of plain text when the editor value carries table markdown", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      contentMarkdown: "| 客户 | 状态 |\n| --- | --- |\n| ACME | 跟进中 |",
      contentHtml:
        "<table><thead><tr><th>客户</th><th>状态</th></tr></thead><tbody><tr><td>ACME</td><td>跟进中</td></tr></tbody></table>",
    }));

    renderPanel({
      notes: [],
      onUpsertNote,
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));
    fireEvent.change(screen.getByLabelText("记录编辑器"), {
      target: {
        value: "table::| 客户 | 状态 |\n| --- | --- |\n| ACME | 跟进中 |",
      },
    });
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onUpsertNote).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      noteType: "quick_note",
      title: "客户",
      markdown: "| 客户 | 状态 |\n| --- | --- |\n| ACME | 跟进中 |",
      html: "<table><thead><tr><th>客户</th><th>状态</th></tr></thead><tbody><tr><td>ACME</td><td>跟进中</td></tr></tbody></table>",
    });
  });

  it("shows record results, toggles preview, and only switches editor after clicking the preview body", async () => {
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
    expect(screen.getByText("Activity Notes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建" })).toBeInTheDocument();
    expect(screen.queryByLabelText("记录编辑器")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "编辑" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("新建、浏览或继续编辑当前 activity 的记录。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/更新于/u)).not.toBeInTheDocument();

    let recordToggle = screen.getByRole("button", { name: /原始记录/ });

    await user.click(recordToggle);
    recordToggle = screen.getByRole("button", { name: /原始记录/ });
    const quickNoteCard = recordToggle.closest("article");
    expect(
      within(quickNoteCard!).getAllByText("客户确认需要补充上下文"),
    ).toHaveLength(2);
    expect(screen.queryByLabelText("记录编辑器")).not.toBeInTheDocument();

    await user.click(within(quickNoteCard!).getByLabelText(/编辑记录：/));
    expect(within(quickNoteCard!).getByLabelText("记录编辑器")).toHaveValue(
      "客户确认需要补充上下文",
    );
    expect(within(quickNoteCard!).getByLabelText("记录编辑器")).toHaveFocus();
    expect(within(quickNoteCard!).getByLabelText("记录标题")).not.toHaveFocus();

    await user.click(screen.getByRole("button", { name: /会议记录/ }));
    expect(screen.queryByLabelText("记录编辑器")).not.toBeInTheDocument();
  });

  it("prevents native text selection on right mouse down for a non-editing record card", async () => {
    const user = userEvent.setup();

    renderPanel({
      notes: [baseNote],
      onDeleteNote: vi.fn(async () => undefined),
    });

    let recordToggle = screen.getByRole("button", { name: /原始记录/ });
    await user.click(recordToggle);
    recordToggle = screen.getByRole("button", { name: /原始记录/ });

    const quickNoteCard = recordToggle.closest("article");
    expect(quickNoteCard).not.toBeNull();

    const mouseDownEvent = new MouseEvent("mousedown", {
      button: 2,
      bubbles: true,
      cancelable: true,
    });

    (quickNoteCard as HTMLElement).dispatchEvent(mouseDownEvent);

    expect(mouseDownEvent.defaultPrevented).toBe(true);
    expect(screen.queryByLabelText("记录编辑器")).not.toBeInTheDocument();
  });

  it("keeps an expanded record open on outside press", async () => {
    const user = userEvent.setup();

    renderPanel({
      notes: [baseNote],
    });

    let recordToggle = screen.getByRole("button", { name: /原始记录/ });

    if (recordToggle.getAttribute("aria-expanded") !== "true") {
      await user.click(recordToggle);
      recordToggle = screen.getByRole("button", { name: /原始记录/ });
    }
    let quickNoteCard = recordToggle.closest("article");
    expect(
      within(quickNoteCard!).getAllByText("客户确认需要补充上下文"),
    ).toHaveLength(2);

    fireEvent.pointerDown(document.body);
    recordToggle = screen.getByRole("button", { name: /原始记录/ });
    quickNoteCard = recordToggle.closest("article");
    expect(
      within(quickNoteCard!).getAllByText("客户确认需要补充上下文"),
    ).toHaveLength(2);
    expect(screen.getByRole("button", { name: "置顶" })).toBeInTheDocument();
  });

  it("opens the note context menu in browse mode without entering edit", async () => {
    renderPanel({
      notes: [baseNote],
      onDeleteNote: vi.fn(async () => undefined),
    });

    const recordToggle = screen.getByRole("button", { name: /原始记录/ });
    const quickNoteCard = recordToggle.closest("article");

    fireEvent.contextMenu(quickNoteCard as HTMLElement, {
      clientX: 160,
      clientY: 84,
    });

    expect(await screen.findByRole("menu", { name: "记录操作" })).toBeInTheDocument();
    expect(
      within(quickNoteCard as HTMLElement).queryByLabelText("记录编辑器"),
    ).not.toBeInTheDocument();
  });

  it("deletes a record from the browse-mode context menu", async () => {
    const user = userEvent.setup();
    const onDeleteNote = vi.fn(async () => undefined);

    renderPanel({
      notes: [baseNote],
      onDeleteNote,
    });

    const recordToggle = screen.getByRole("button", { name: /原始记录/ });
    const quickNoteCard = recordToggle.closest("article");

    fireEvent.contextMenu(quickNoteCard as HTMLElement, {
      clientX: 160,
      clientY: 84,
    });

    await user.click(await screen.findByRole("menuitem", { name: "删除" }));

    expect(onDeleteNote).toHaveBeenCalledWith(1);
  });

  it("moves a topped record to the top without keeping it expanded", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel({
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

    expect(recordOrder(container)).toEqual(["note-2", "note-1"]);

    let quickNoteToggle = screen.getByRole("button", { name: /原始记录/ });

    await user.click(quickNoteToggle);
    quickNoteToggle = screen.getByRole("button", { name: /原始记录/ });
    let quickNoteCard = quickNoteToggle.closest("article");
    await user.click(
      within(quickNoteCard!).getByRole("button", { name: "置顶" }),
    );
    expect(
      within(quickNoteCard!).getByRole("button", { name: "取消置顶" }),
    ).toBeInTheDocument();
    expect(recordOrder(container)).toEqual(["note-1", "note-2"]);

    let meetingToggle = screen.getByRole("button", { name: /会议记录/ });
    await user.click(meetingToggle);
    quickNoteToggle = screen.getByRole("button", { name: /原始记录/ });
    meetingToggle = screen.getByRole("button", { name: /会议记录/ });
    quickNoteCard = quickNoteToggle.closest("article");
    const meetingCard = meetingToggle.closest("article");

    expect(recordOrder(container)).toEqual(["note-1", "note-2"]);
    expect(
      within(quickNoteCard!).getAllByText("客户确认需要补充上下文"),
    ).toHaveLength(1);
    expect(
      within(meetingCard!).getByText("确认本周五前补齐材料"),
    ).toBeInTheDocument();
  });

  it("switches to another record preview with a single click while one record is already expanded", async () => {
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

    let quickNoteToggle = screen.getByRole("button", { name: /原始记录/ });
    let meetingToggle = screen.getByRole("button", { name: /会议记录/ });

    if (quickNoteToggle.getAttribute("aria-expanded") !== "true") {
      await user.click(quickNoteToggle);
      quickNoteToggle = screen.getByRole("button", { name: /原始记录/ });
      meetingToggle = screen.getByRole("button", { name: /会议记录/ });
    }

    let quickNoteCard = quickNoteToggle.closest("article");
    let meetingCard = meetingToggle.closest("article");

    expect(
      within(quickNoteCard!).getAllByText("客户确认需要补充上下文"),
    ).toHaveLength(2);
    expect(
      within(meetingCard!).queryByText("确认本周五前补齐材料"),
    ).not.toBeInTheDocument();

    await user.click(meetingToggle);

    quickNoteToggle = screen.getByRole("button", { name: /原始记录/ });
    meetingToggle = screen.getByRole("button", { name: /会议记录/ });
    quickNoteCard = quickNoteToggle.closest("article");
    meetingCard = meetingToggle.closest("article");

    expect(quickNoteToggle).toHaveAttribute("aria-expanded", "false");
    expect(meetingToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      within(quickNoteCard!).getAllByText("客户确认需要补充上下文"),
    ).toHaveLength(1);
    expect(
      within(meetingCard!).getByText("确认本周五前补齐材料"),
    ).toBeInTheDocument();
  });

  it("returns the record to preview mode in place after saving", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      contentMarkdown: "调整后的记录",
      contentHtml: "<p>调整后的记录</p>",
      updatedAt: "2026-04-06T10:20:00.000Z",
    }));

    renderPanel({
      notes: [baseNote],
      onUpsertNote,
    });

    const recordToggle = screen.getByRole("button", { name: /原始记录/ });
    const quickNoteCard = recordToggle.closest("article");

    await user.click(within(quickNoteCard!).getByLabelText(/编辑记录：/));
    await user.clear(within(quickNoteCard!).getByLabelText("记录编辑器"));
    await user.type(
      within(quickNoteCard!).getByLabelText("记录编辑器"),
      "调整后的记录",
    );
    await user.click(
      within(quickNoteCard!).getByRole("button", { name: "保存" }),
    );

    expect(onUpsertNote).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      noteId: 1,
      noteType: "quick_note",
      title: "调整后的记录",
      markdown: "调整后的记录",
      html: "<p>调整后的记录</p>",
    });
    await waitFor(() =>
      expect(
        within(quickNoteCard!).queryByLabelText("记录编辑器"),
      ).not.toBeInTheDocument(),
    );
    expect(within(quickNoteCard!).getAllByText("调整后的记录")).toHaveLength(2);
  });

  it("autosaves on blur and returns to the expanded preview without collapsing", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      contentMarkdown: "失焦后自动保存的记录",
      contentHtml: "<p>失焦后自动保存的记录</p>",
      updatedAt: "2026-04-06T10:25:00.000Z",
    }));

    renderPanel({
      notes: [baseNote],
      onUpsertNote,
    });

    const recordToggle = screen.getByRole("button", { name: /原始记录/ });
    const quickNoteCard = recordToggle.closest("article");

    if (recordToggle.getAttribute("aria-expanded") !== "true") {
      await user.click(recordToggle);
    }
    await user.click(within(quickNoteCard!).getByLabelText(/编辑记录：/));
    await user.clear(within(quickNoteCard!).getByLabelText("记录编辑器"));
    await user.type(
      within(quickNoteCard!).getByLabelText("记录编辑器"),
      "失焦后自动保存的记录",
    );
    fireEvent.blur(within(quickNoteCard!).getByLabelText("记录编辑器"), {
      relatedTarget: document.body,
    });
    fireEvent.focusIn(document.body);

    await waitFor(() =>
      expect(onUpsertNote).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        noteId: 1,
        noteType: "quick_note",
        title: "失焦后自动保存的记录",
        markdown: "失焦后自动保存的记录",
        html: "<p>失焦后自动保存的记录</p>",
      }),
    );
    expect(
      within(quickNoteCard!).queryByLabelText("记录编辑器"),
    ).not.toBeInTheDocument();
    expect(recordToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      within(quickNoteCard!).getAllByText("失焦后自动保存的记录"),
    ).toHaveLength(2);
  });

  it("saves and exits editing when pressing Ctrl/Cmd + Enter", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      contentMarkdown: "快捷键保存后的记录",
      contentHtml: "<p>快捷键保存后的记录</p>",
      updatedAt: "2026-04-06T10:26:00.000Z",
    }));

    renderPanel({
      notes: [baseNote],
      onUpsertNote,
    });

    const recordToggle = screen.getByRole("button", { name: /原始记录/ });
    const quickNoteCard = recordToggle.closest("article");

    await user.click(within(quickNoteCard!).getByLabelText(/编辑记录：/));
    await user.clear(within(quickNoteCard!).getByLabelText("记录编辑器"));
    await user.type(
      within(quickNoteCard!).getByLabelText("记录编辑器"),
      "快捷键保存后的记录",
    );
    fireEvent.keyDown(within(quickNoteCard!).getByLabelText("记录编辑器"), {
      key: "Enter",
      ctrlKey: true,
    });

    await waitFor(() =>
      expect(onUpsertNote).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        noteId: 1,
        noteType: "quick_note",
        title: "快捷键保存后的记录",
        markdown: "快捷键保存后的记录",
        html: "<p>快捷键保存后的记录</p>",
      }),
    );
    await waitFor(() =>
      expect(
        within(quickNoteCard!).queryByLabelText("记录编辑器"),
      ).not.toBeInTheDocument(),
    );
  });

  it("opens the dedicated note focus page via callback without closing the current editor", async () => {
    const user = userEvent.setup();
    const onOpenNoteFocus = vi.fn();

    renderPanel({
      notes: [baseNote],
      onOpenNoteFocus,
    });

    const quickNoteCard = screen
      .getByRole("button", { name: /原始记录/ })
      .closest("article");
    await user.click(within(quickNoteCard!).getByLabelText(/编辑记录：/));
    await user.clear(within(quickNoteCard!).getByLabelText("记录编辑器"));
    await user.type(within(quickNoteCard!).getByLabelText("记录编辑器"), "准备进入专注页");
    await user.click(within(quickNoteCard!).getByRole("button", { name: "全页编辑" }));

    expect(onOpenNoteFocus).toHaveBeenCalledWith({
      kind: "saved",
      noteId: 1,
    });
    expect(within(quickNoteCard!).getByLabelText("记录编辑器")).toHaveValue(
      "准备进入专注页",
    );
  });

  it("restores the cached editing session after remounting from the focus page", async () => {
    const user = userEvent.setup();
    const onOpenNoteFocus = vi.fn();

    const firstRender = renderPanel({
      notes: [baseNote],
      onOpenNoteFocus,
    });

    const quickNoteCard = screen
      .getByRole("button", { name: /原始记录/ })
      .closest("article");
    await user.click(within(quickNoteCard!).getByLabelText(/编辑记录：/));
    await user.clear(within(quickNoteCard!).getByLabelText("记录编辑器"));
    await user.type(within(quickNoteCard!).getByLabelText("记录编辑器"), "从专注页返回后继续编辑");
    await user.click(within(quickNoteCard!).getByRole("button", { name: "全页编辑" }));

    firstRender.unmount();

    renderPanel({
      notes: [baseNote],
    });

    expect(screen.getByLabelText("记录编辑器")).toHaveValue(
      "从专注页返回后继续编辑",
    );
    expect(screen.getByLabelText("记录标题")).toHaveValue("");
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
    await user.type(
      screen.getByLabelText("记录编辑器"),
      "客户确认需要补充上下文",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(onUpsertNote).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        noteType: "meeting_minutes",
        title: "客户确认需要补充上下文",
        markdown: "背景\n讨论要点\n初步结论\n行动项客户确认需要补充上下文",
        html: "<p>背景\n讨论要点\n初步结论\n行动项客户确认需要补充上下文</p>",
      }),
    );
  });

  it("saves the current draft before switching to another record type", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      id: 5,
      noteType: "meeting_minutes",
      title: "会议记录",
      contentMarkdown: "背景\n讨论要点\n初步结论\n行动项客户确认需要补充上下文",
      contentHtml:
        "<p>背景\n讨论要点\n初步结论\n行动项客户确认需要补充上下文</p>",
      updatedAt: "2026-04-06T10:35:00.000Z",
    }));

    renderPanel({
      notes: [baseNote],
      onUpsertNote,
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "会议记录" }));
    await user.type(
      screen.getByLabelText("记录编辑器"),
      "客户确认需要补充上下文",
    );

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));

    expect(mockPushToast).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onUpsertNote).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        noteType: "meeting_minutes",
        title: "客户确认需要补充上下文",
        markdown: "背景\n讨论要点\n初步结论\n行动项客户确认需要补充上下文",
        html: "<p>背景\n讨论要点\n初步结论\n行动项客户确认需要补充上下文</p>",
      }),
    );
    expect(screen.getByLabelText("记录编辑器")).toHaveValue("");
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
    const onUpsertNote = vi.fn(async (input: { title?: string }) => ({
      ...savedNote,
      title: input.title ?? savedNote.title,
    }));
    const onGenerateAiSuggestions = vi.fn(async () => suggestions);
    const onAcceptAiSuggestion = vi.fn(
      async ({ suggestionId }: { suggestionId: number }) => ({
        suggestion:
          suggestions.find((item) => item.id === suggestionId) ??
          suggestions[1],
        entityKind: suggestionId === 32 ? "conclusion" : "todo",
        entityId: suggestionId + 100,
      }),
    );

    renderPanel({
      notes: [],
      onUpsertNote,
      showAiRefine: true,
      aiReady: true,
      enabledSuggestionTypes: ["conclusion", "todo"],
      onGenerateAiSuggestions,
      onAcceptAiSuggestion,
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));
    await user.type(
      screen.getByLabelText("记录编辑器"),
      "确认预算范围，需要财务补充拆分明细",
    );
    await user.click(screen.getByRole("button", { name: "AI 提炼" }));

    await waitFor(() =>
      expect(onUpsertNote).toHaveBeenCalledWith({
        projectId: 9,
        activityId: 11,
        noteType: "quick_note",
        title: "确认预算范围，需要财务补充拆分明细",
        markdown: "确认预算范围，需要财务补充拆分明细",
        html: "<p>确认预算范围，需要财务补充拆分明细</p>",
      }),
    );
    expect(onGenerateAiSuggestions).toHaveBeenCalledWith(7);
    expect(onUpsertNote).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      noteId: 7,
      noteType: "quick_note",
      title: "预算讨论 - 阶段整理",
      markdown: "确认预算范围，需要财务补充拆分明细",
      html: "<p>确认预算范围，需要财务补充拆分明细</p>",
    });

    expect(await screen.findByText("确认 AI 提炼")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "已确认预算范围和审批边界" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "财务补充预算拆分明细" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "下次会议前同步审批时间表" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("结论内容 1")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("待办内容 1")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认并写入（3项）" }));

    await waitFor(() => expect(onAcceptAiSuggestion).toHaveBeenCalledTimes(3));
    expect(onAcceptAiSuggestion).toHaveBeenNthCalledWith(1, {
      suggestionId: 32,
      payloadOverride: {
        content: "已确认预算范围和审批边界",
        promotedToProject: true,
      },
    });
    expect(onAcceptAiSuggestion).toHaveBeenNthCalledWith(2, {
      suggestionId: 33,
      payloadOverride: {
        content: "财务补充预算拆分明细",
        priority: "not_urgent_important",
      },
    });
    expect(onAcceptAiSuggestion).toHaveBeenNthCalledWith(3, {
      suggestionId: 34,
      payloadOverride: {
        content: "下次会议前同步审批时间表",
        priority: "not_urgent_important",
      },
    });
  });

  it("keeps only enabled suggestion subfeatures in the confirmation dialog", async () => {
    const user = userEvent.setup();
    const savedNote = {
      ...baseNote,
      id: 8,
      title: "会议纪要",
      contentMarkdown: "确认预算范围，需要财务补充拆分明细",
      contentHtml: "<p>确认预算范围，需要财务补充拆分明细</p>",
    };
    const suggestions: AiSuggestionRecord[] = [
      {
        id: 41,
        projectId: 9,
        activityId: 11,
        noteId: 8,
        suggestionType: "conclusion",
        title: "结论候选",
        preview: "已确认预算范围和审批边界",
        payload: { content: "已确认预算范围和审批边界" },
        status: "pending",
        createdAt: "2026-04-06T10:10:00.000Z",
      },
      {
        id: 42,
        projectId: 9,
        activityId: 11,
        noteId: 8,
        suggestionType: "todo",
        title: "待办候选",
        preview: "财务补充预算拆分明细",
        payload: { content: "财务补充预算拆分明细" },
        status: "pending",
        createdAt: "2026-04-06T10:10:00.000Z",
      },
    ];
    const onGenerateAiSuggestions = vi.fn(async () => suggestions);
    const onAcceptAiSuggestion = vi.fn(
      async ({ suggestionId }: { suggestionId: number }) => ({
        suggestion:
          suggestions.find((item) => item.id === suggestionId) ??
          suggestions[0],
        entityKind: "conclusion",
        entityId: suggestionId + 100,
      }),
    );

    renderPanel({
      notes: [],
      onUpsertNote: vi.fn(async () => savedNote),
      showAiRefine: true,
      aiReady: true,
      enabledSuggestionTypes: ["conclusion"],
      onGenerateAiSuggestions,
      onAcceptAiSuggestion,
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));
    await user.type(
      screen.getByLabelText("记录编辑器"),
      "确认预算范围，需要财务补充拆分明细",
    );
    await user.click(screen.getByRole("button", { name: "AI 提炼" }));

    expect(await screen.findByText("会议结论")).toBeInTheDocument();
    expect(screen.queryByText("待办事项")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "已确认预算范围和审批边界" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("结论内容 1")).not.toBeInTheDocument();
    expect(screen.queryByText("财务补充预算拆分明细")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认并写入（1项）" }));

    await waitFor(() => expect(onAcceptAiSuggestion).toHaveBeenCalledTimes(1));
    expect(onAcceptAiSuggestion).toHaveBeenCalledWith({
      suggestionId: 41,
      payloadOverride: {
        content: "已确认预算范围和审批边界",
        promotedToProject: true,
      },
    });
  });

  it("prefers a user-entered title over automatic title generation", async () => {
    const user = userEvent.setup();
    const onUpsertNote = vi.fn(async () => ({
      ...baseNote,
      title: "法务审查",
      contentMarkdown: "客户确认需要补充上下文",
      contentHtml: "<p>客户确认需要补充上下文</p>",
    }));
    const onGenerateAiSuggestions = vi.fn(async () => []);

    renderPanel({
      notes: [],
      onUpsertNote,
      aiReady: true,
      onGenerateAiSuggestions,
    });

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));
    fireEvent.change(screen.getByLabelText("记录标题"), {
      target: { value: "法务审查" },
    });
    await user.type(
      screen.getByLabelText("记录编辑器"),
      "客户确认需要补充上下文",
    );
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(onUpsertNote).toHaveBeenCalledWith({
      projectId: 9,
      activityId: 11,
      noteType: "quick_note",
      title: "法务审查",
      markdown: "客户确认需要补充上下文",
      html: "<p>客户确认需要补充上下文</p>",
    });
    expect(onGenerateAiSuggestions).not.toHaveBeenCalled();
  });

  it("moves focus from the title input into the editor body on Tab and Enter", async () => {
    const user = userEvent.setup();

    renderPanel({
      notes: [baseNote],
    });

    const recordToggle = screen.getByRole("button", { name: /原始记录/ });
    const quickNoteCard = recordToggle.closest("article");

    await user.click(within(quickNoteCard!).getByLabelText(/编辑记录：/));

    const titleInput = within(quickNoteCard!).getByLabelText("记录标题");
    const editor = within(quickNoteCard!).getByLabelText("记录编辑器");

    titleInput.focus();
    expect(titleInput).toHaveFocus();

    fireEvent.keyDown(titleInput, {
      key: "Tab",
    });
    expect(editor).toHaveFocus();

    titleInput.focus();
    expect(titleInput).toHaveFocus();

    fireEvent.keyDown(titleInput, {
      key: "Enter",
    });
    expect(editor).toHaveFocus();
  });
});

function renderPanel({
  projectId = 9,
  activityId = 11,
  notes = [],
  fullPageActive = false,
  onFullPageChange = vi.fn(),
  onUpsertNote = vi.fn(async () => baseNote) as (
    input: import("../../lib/types").NoteUpsertInput,
  ) => Promise<NoteRecord>,
  showAiRefine = false,
  aiReady = false,
  enabledSuggestionTypes = [],
  onGenerateAiSuggestions,
  onAcceptAiSuggestion,
  onDeleteNote,
  onOpenNoteFocus,
}: {
  projectId?: number;
  activityId?: number;
  notes?: NoteRecord[];
  fullPageActive?: boolean;
  onFullPageChange?: (next: boolean) => void;
  onUpsertNote?: (
    input: import("../../lib/types").NoteUpsertInput,
  ) => Promise<NoteRecord>;
  showAiRefine?: boolean;
  aiReady?: boolean;
  enabledSuggestionTypes?: Array<"conclusion" | "todo">;
  onGenerateAiSuggestions?: (noteId: number) => Promise<AiSuggestionRecord[]>;
  onAcceptAiSuggestion?: (
    input: import("../../lib/types").AiAcceptSuggestionInput,
  ) => Promise<import("../../lib/types").AcceptedSuggestionResult>;
  onDeleteNote?: (noteId: number) => Promise<unknown> | unknown;
  onOpenNoteFocus?: (target: { kind: "saved"; noteId: number } | { kind: "draft"; localId: string }) => void;
}) {
  return render(
    <ActivityNotesPanel
      projectId={projectId}
      activityId={activityId}
      notes={notes}
      fullPageActive={fullPageActive}
      onFullPageChange={onFullPageChange}
      recordTypeSettings={recordTypeSettings}
      saving={false}
      onUpsertNote={onUpsertNote}
      onDeleteNote={onDeleteNote}
      onImportImage={vi.fn()}
      onImportDocument={vi.fn()}
      showAiRefine={showAiRefine}
      aiReady={aiReady}
      enabledSuggestionTypes={enabledSuggestionTypes}
      onGenerateAiSuggestions={onGenerateAiSuggestions}
      onAcceptAiSuggestion={onAcceptAiSuggestion}
      onOpenNoteFocus={onOpenNoteFocus}
    />,
  );
}

function recordOrder(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll(".activity-notes__results > article"),
  ).map((item) => item.id);
}

function toPlainText(html: string) {
  return html
    .replace(/<\/(h1|h2|h3|p|li)>/g, "\n")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function toMockEditorValue(html: string) {
  if (html.includes("<table")) {
    return `table::${tableHtmlToMarkdown(html)}`;
  }

  return toPlainText(html);
}

function buildMockRichValue(source: string) {
  const normalized = source.trim();

  if (normalized.startsWith("table::")) {
    const markdown = normalized.slice("table::".length).trim();
    const lines = markdown.split("\n").filter((line) => line.trim().length > 0);

    if (lines.length >= 3) {
      return {
        html: toTableHtml(markdown),
        text: markdown
          .replace(/[|\-:]/g, " ")
          .replace(/\s+/g, " ")
          .trim(),
        markdown,
      };
    }
  }

  return {
    html: toHtml(normalized),
    text: normalized,
    markdown: normalized,
  };
}

function toHtml(text: string) {
  const normalized = text.trim();
  return normalized.length > 0 ? `<p>${normalized}</p>` : "<p></p>";
}

function toTableHtml(markdown: string) {
  const lines = markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [headerLine, , ...bodyLines] = lines;
  const headerCells = parseTableCells(headerLine);
  const bodyRows = bodyLines.map((line) => parseTableCells(line));

  return `<table><thead><tr>${headerCells.map((cell) => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${bodyRows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function parseTableCells(line: string) {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function tableHtmlToMarkdown(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows = Array.from(doc.querySelectorAll("tr")).map((row) =>
    Array.from(row.querySelectorAll("th, td"))
      .map((cell) => cell.textContent?.trim() ?? "")
      .join(" | "),
  );

  if (rows.length === 0) {
    return "";
  }

  const headerCells = rows[0].split(" | ");
  const separator = new Array(headerCells.length).fill("---").join(" | ");

  return [
    `| ${rows[0]} |`,
    `| ${separator} |`,
    ...rows.slice(1).map((row) => `| ${row} |`),
  ].join("\n");
}
