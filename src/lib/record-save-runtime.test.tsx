import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { NoteRecord, ProjectPageData, WorkspacePageData, WorkspaceRecord } from "./types";
import { queryKeys } from "./queryKeys";
import { createRecordSaveCoordinator } from "./record-save-runtime";
import { projectMindApi } from "../services/projectMindApi";

vi.mock("../services/projectMindApi", () => ({
  projectMindApi: {
    projectRecordUpsert: vi.fn(),
    workspaceRecordUpsert: vi.fn(),
  },
}));

function record(markdown: string, updatedAt: string): NoteRecord {
  return {
    id: 7,
    projectId: 1,
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
    const coordinator = createRecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      queryClient,
    });
    const base = {
      scope: "project" as const,
      workspaceKey: "/tmp/workspace",
      projectId: 1,
      recordId: 7,
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

    expect(queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(1))?.records?.[0]?.contentMarkdown).toBe(
      "cached",
    );
    await coordinator.flush();
    expect(projectMindApi.projectRecordUpsert).toHaveBeenLastCalledWith({
      projectId: 1,
      noteId: 7,
      title: "Latest title",
      markdown: "new",
      html: "<p>new</p>",
      defaultCodeLanguage: "typescript",
      tagIds: [3, 5],
    });
    expect(queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(1))?.records?.[0]?.contentMarkdown).toBe(
      "new",
    );
  });

  it("persists a Workspace Record snapshot and publishes it to the Workspace cache", async () => {
    const cached: WorkspaceRecord = {
      id: 7,
      title: "Old",
      contentMarkdown: "old",
      contentHtml: "<p>old</p>",
      tags: [],
      createdAt: "created",
      updatedAt: "old-time",
    };
    const saved: WorkspaceRecord = {
      ...cached,
      title: "Latest",
      contentMarkdown: "new",
      contentHtml: "<p>new</p>",
      updatedAt: "new-time",
    };
    vi.mocked(projectMindApi.workspaceRecordUpsert).mockResolvedValue(saved);
    const queryClient = new QueryClient();
    queryClient.setQueryData<WorkspacePageData>(queryKeys.workspacePage, {
      quickNote: null,
      records: [cached],
      unfinishedTodos: [],
      finishedTodos: [],
    });
    const coordinator = createRecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      queryClient,
    });

    coordinator.submit({
      scope: "workspace",
      workspaceKey: "/tmp/workspace",
      recordId: 7,
      title: " Latest ",
      tagIds: [],
      defaultCodeLanguage: null,
      committedContent: { html: "<p>new</p>", text: "new", markdown: "new" },
    });
    await coordinator.flush();

    expect(projectMindApi.workspaceRecordUpsert).toHaveBeenCalledWith({
      noteId: 7,
      title: "Latest",
      markdown: "new",
      html: "<p>new</p>",
      defaultCodeLanguage: null,
      tagIds: [],
    });
    expect(queryClient.getQueryData<WorkspacePageData>(queryKeys.workspacePage)?.records?.[0]?.contentMarkdown).toBe(
      "new",
    );
  });
});
