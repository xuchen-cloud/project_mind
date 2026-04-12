import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  DocumentRecord,
  NoteRecord,
  RecordTypeSettingsSnapshot,
} from "../../lib/types";
import { desktopApi } from "../../services/desktopApi";
import { ActivityNotesPanel } from "./ActivityNotesPanel";

const { mockPushToast } = vi.hoisted(() => ({
  mockPushToast: vi.fn(),
}));

vi.mock("../../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: mockPushToast,
  }),
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
  ],
};

beforeAll(() => {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 24,
    right: 240,
    width: 240,
    height: 24,
    toJSON: () => ({}),
  } satisfies DOMRect;
  const createRectList = () =>
    ({
      0: rect,
      length: 1,
      item: (index: number) => (index === 0 ? rect : null),
      [Symbol.iterator]: function* iterator() {
        yield rect;
      },
    }) as DOMRectList;

  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => null,
  });
  Object.defineProperty(window, "scrollBy", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: createRectList,
  });
  Object.defineProperty(Text.prototype, "getClientRects", {
    configurable: true,
    value: createRectList,
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: createRectList,
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(() => true),
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      const styleWidth = Number.parseFloat(
        this.style.width ||
          this.style.minWidth ||
          this.getAttribute("width") ||
          "0",
      );

      if (Number.isFinite(styleWidth) && styleWidth > 0) {
        return styleWidth;
      }

      return this.tagName === "IMG" ? 240 : 48;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      const styleHeight = Number.parseFloat(
        this.style.height || this.getAttribute("height") || "0",
      );

      if (Number.isFinite(styleHeight) && styleHeight > 0) {
        return styleHeight;
      }

      return this.tagName === "IMG" ? 160 : 48;
    },
  });
});

describe("ActivityNotesPanel image persistence", () => {
  beforeEach(() => {
    mockPushToast.mockReset();
    vi.spyOn(desktopApi, "pickFile").mockResolvedValue("/tmp/clip.png");
    vi.spyOn(desktopApi, "readFileAsDataUrl").mockImplementation(
      async (path, mimeType) => {
        const resolvedMimeType = mimeType || "image/png";
        return `data:${resolvedMimeType};base64,${btoa(path)}`;
      },
    );
    vi.spyOn(desktopApi, "toFileUrl").mockImplementation(
      (path) => `asset://${path}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it("keeps an inserted image visible after saving and reopening the note editor", async () => {
    const user = userEvent.setup();
    const onImportImage = vi.fn(
      async (sourcePath: string): Promise<DocumentRecord> => ({
        id: 301,
        projectId: 9,
        activityId: 11,
        name: "clip.png",
        baseName: "clip",
        originalPath: sourcePath,
        managedPath:
          "/tmp/project-atlas/.project-mind/embedded-note-assets/activity-11/clip.png",
        historyDirPath:
          "/tmp/project-atlas/.project-mind/embedded-note-assets/activity-11/.301.pm-versions",
        storageMode: "managed_note_image",
        mimeType: "image/png",
        isStarred: false,
        currentVersionNumber: 1,
        versionCount: 1,
        sourceActivityTitle: null,
        health: "normal",
        tags: [],
        createdAt: "2026-04-12T09:00:00.000Z",
        updatedAt: "2026-04-12T09:00:00.000Z",
      }),
    );
    const onUpsertNote = vi.fn(
      async (input: {
        noteId?: number;
        noteType: string;
        title?: string;
        markdown: string;
        html: string;
      }): Promise<NoteRecord> => ({
        id: input.noteId ?? 101,
        projectId: 9,
        activityId: 11,
        noteType: input.noteType,
        title: input.title ?? null,
        contentMarkdown: input.markdown,
        contentHtml: input.html,
        createdAt: "2026-04-12T09:00:00.000Z",
        updatedAt: "2026-04-12T09:05:00.000Z",
      }),
    );

    render(
      <ActivityNotesPanel
        projectId={9}
        activityId={11}
        notes={[]}
        recordTypeSettings={recordTypeSettings}
        saving={false}
        onUpsertNote={onUpsertNote}
        onImportImage={onImportImage}
        onImportDocument={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "新建" }));
    await user.click(screen.getByRole("menuitem", { name: "原始记录" }));
    await user.click(await screen.findByLabelText("图片"));
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(onUpsertNote).toHaveBeenCalledTimes(1);
      expect(onUpsertNote.mock.calls[0]?.[0]?.html).toContain(
        'src="data:image/png;base64,',
      );
      expect(onUpsertNote.mock.calls[0]?.[0]?.html).toContain(
        'data-path="/tmp/project-atlas/.project-mind/embedded-note-assets/activity-11/clip.png"',
      );
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("记录编辑器")).not.toBeInTheDocument();
    });

    const recordToggle = await screen.findByRole("button", {
      name: /原始记录/i,
    });
    const recordCard = recordToggle.closest("article");
    expect(recordCard).toBeTruthy();

    await user.click(
      within(recordCard as HTMLElement).getByLabelText(/编辑记录：/),
    );

    const image = await waitFor(() => {
      const nextImage = (recordCard as HTMLElement).querySelector("img");

      expect(nextImage).toBeTruthy();
      return nextImage as HTMLImageElement;
    });

    expect(image.getAttribute("src")).toContain("data:image/png;base64,");
    expect(onImportImage).toHaveBeenCalledWith("/tmp/clip.png");
  });
});
