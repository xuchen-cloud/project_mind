import { describe, expect, it } from "vitest";

import type { WorkspaceRecord } from "./types";
import { buildWorkspaceRecordRenameInput } from "./workspace-records";

describe("buildWorkspaceRecordRenameInput", () => {
  it("preserves committed Workspace Record content while replacing the title", () => {
    const record: WorkspaceRecord = {
      id: 11,
      title: "旧标题",
      contentMarkdown: "记录内容",
      contentHtml: "<p>记录内容</p>",
      defaultCodeLanguage: "typescript",
      tags: [
        {
          id: 7,
          label: "方法",
          colorKey: "blue",
        },
      ],
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: "2026-09-05T08:00:00.000Z",
    };

    expect(buildWorkspaceRecordRenameInput(record, "  新标题  ")).toEqual({
      noteId: 11,
      title: "新标题",
      markdown: "记录内容",
      html: "<p>记录内容</p>",
      defaultCodeLanguage: "typescript",
      tagIds: [7],
    });
  });

  it("normalizes a blank title to an unnamed Record", () => {
    const record: WorkspaceRecord = {
      id: 11,
      title: "旧标题",
      contentMarkdown: "",
      contentHtml: "<p></p>",
      tags: [],
      createdAt: "",
      updatedAt: "",
    };

    expect(buildWorkspaceRecordRenameInput(record, "   ").title).toBeUndefined();
  });
});
