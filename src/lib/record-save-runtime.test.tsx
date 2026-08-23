import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { NoteRecord, ProjectPageData } from "./types";
import { queryKeys } from "./queryKeys";
import { createProjectRecordSaveCoordinator } from "./record-save-runtime";
import { projectMindApi } from "../services/projectMindApi";

vi.mock("../services/projectMindApi", () => ({
  projectMindApi: {
    projectRecordUpsert: vi.fn(),
  },
}));

function record(markdown: string, updatedAt: string): NoteRecord {
  return {
    id: 7,
    projectId: 1,
    activityId: null,
    title: "Record title",
    contentMarkdown: markdown,
    contentHtml: `<p>${markdown}</p>`,
    defaultCodeLanguage: "typescript",
    tags: [],
    createdAt: "created",
    updatedAt,
  };
}

function projectPage(value: NoteRecord): ProjectPageData {
  return {
    project: null,
    records: [value],
    unfinishedTodos: [],
    finishedTodos: [],
    projectDocuments: [],
  };
}

describe("project Record save runtime", () => {
  it("persists the complete snapshot and only publishes the newest result to React Query", async () => {
    let finishOld!: (value: NoteRecord) => void;
    const oldWrite = new Promise<NoteRecord>((resolve) => {
      finishOld = resolve;
    });
    vi.mocked(projectMindApi.projectRecordUpsert)
      .mockImplementationOnce(() => oldWrite)
      .mockImplementationOnce(async () => record("new", "new-time"));
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.projectPage(1), projectPage(record("cached", "cached-time")));
    const coordinator = createProjectRecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      queryClient,
    });
    const base = {
      workspaceKey: "/tmp/workspace",
      projectId: 1,
      noteId: 7,
      activityId: 12,
      title: " Latest title ",
      tagIds: [3, 5],
      defaultCodeLanguage: "typescript",
    };

    coordinator.submit({
      ...base,
      committedContent: { html: "<p>old</p>", text: "old", markdown: "old" },
    });
    coordinator.submit({
      ...base,
      committedContent: { html: "<p>new</p>", text: "new", markdown: "new" },
    });
    finishOld(record("old", "old-time"));
    await Promise.resolve();

    expect(
      queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(1))?.records?.[0]
        ?.contentMarkdown,
    ).toBe("cached");
    await coordinator.flush();
    expect(projectMindApi.projectRecordUpsert).toHaveBeenLastCalledWith({
      projectId: 1,
      activityId: 12,
      noteId: 7,
      title: "Latest title",
      markdown: "new",
      html: "<p>new</p>",
      defaultCodeLanguage: "typescript",
      tagIds: [3, 5],
    });
    expect(
      queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(1))?.records?.[0]
        ?.contentMarkdown,
    ).toBe("new");
  });
});
