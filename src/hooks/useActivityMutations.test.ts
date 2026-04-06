import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { ActivityCardData, NoteRecord } from "../lib/types";
import { upsertNoteInCache } from "./useActivityMutations";

describe("upsertNoteInCache", () => {
  it("adds a new note, increments the count, and sorts by updated time", () => {
    const queryClient = new QueryClient();
    const existingNote = buildNote({
      id: 1,
      contentMarkdown: "Earlier note",
      contentHtml: "<p>Earlier note</p>",
      updatedAt: "2026-04-06T08:00:00.000Z",
    });

    queryClient.setQueryData(["activities", 1], [buildActivity({ notes: [existingNote], noteCount: 1 })]);

    upsertNoteInCache(
      queryClient,
      buildNote({
        id: 2,
        noteType: "meeting_minutes",
        title: "会议纪要",
        contentMarkdown: "Later note",
        contentHtml: "<p>Later note</p>",
        updatedAt: "2026-04-06T10:00:00.000Z",
      }),
    );

    const nextActivities = queryClient.getQueryData<ActivityCardData[]>(["activities", 1]);

    expect(nextActivities?.[0].digest.noteCount).toBe(2);
    expect(nextActivities?.[0].notes.map((note) => note.id)).toEqual([2, 1]);
  });

  it("updates an existing note without changing the count", () => {
    const queryClient = new QueryClient();
    const existingNote = buildNote({
      id: 1,
      contentMarkdown: "Captured detail",
      contentHtml: "<p>Captured detail</p>",
    });

    queryClient.setQueryData(["activities", 1], [buildActivity({ notes: [existingNote], noteCount: 1 })]);

    upsertNoteInCache(
      queryClient,
      buildNote({
        id: 1,
        noteType: "meeting_minutes",
        title: "会议纪要",
        contentMarkdown: "Captured detail",
        contentHtml: "<p>Captured detail</p>",
        updatedAt: "2026-04-06T11:00:00.000Z",
      }),
    );

    const nextActivities = queryClient.getQueryData<ActivityCardData[]>(["activities", 1]);

    expect(nextActivities?.[0].digest.noteCount).toBe(1);
    expect(nextActivities?.[0].notes[0].noteType).toBe("meeting_minutes");
    expect(nextActivities?.[0].notes[0].title).toBe("会议纪要");
  });
});

function buildActivity({
  notes,
  noteCount,
}: {
  notes: NoteRecord[];
  noteCount: number;
}): ActivityCardData {
  return {
    id: 11,
    projectId: 1,
    attributeOptionId: 7,
    attributeLabel: "会议同步",
    title: "Kickoff",
    activityTime: "2026-04-06T08:00:00.000Z",
    statusOptionId: 2,
    statusLabel: "待复核",
    statusNeedsAttention: true,
    isPinned: false,
    isExpanded: true,
    createdAt: "2026-04-06T08:00:00.000Z",
    updatedAt: "2026-04-06T08:00:00.000Z",
    notes,
    conclusions: [],
    todos: [],
    documents: [],
    aiSuggestions: [],
    digest: {
      id: 11,
      projectId: 1,
      attributeOptionId: 7,
      attributeLabel: "会议同步",
      title: "Kickoff",
      activityTime: "2026-04-06T08:00:00.000Z",
      statusOptionId: 2,
      statusLabel: "待复核",
      statusNeedsAttention: true,
      isPinned: false,
      noteCount,
      conclusionCount: 0,
      todoCount: 0,
      documentCount: 0,
      completedTodoCount: 0,
      totalTodoCount: 0,
      hasOpenTodos: false,
    },
  } as ActivityCardData;
}

function buildNote(partial: Partial<NoteRecord> & Pick<NoteRecord, "id">): NoteRecord {
  return {
    id: partial.id,
    projectId: 1,
    activityId: 11,
    noteType: partial.noteType ?? "quick_note",
    title: partial.title ?? "原始记录",
    contentMarkdown: partial.contentMarkdown ?? "",
    contentHtml: partial.contentHtml ?? "<p></p>",
    createdAt: partial.createdAt ?? "2026-04-06T08:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-04-06T09:00:00.000Z",
  };
}
