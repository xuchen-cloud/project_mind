import { beforeEach, describe, expect, it } from "vitest";

import {
  clearAllTodoComposerDrafts,
  readTodoComposerDraft,
  writeTodoComposerDraft,
} from "./todo-draft-storage";

describe("Todo composer draft storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips selected Tags and Subtask drafts with the Todo card draft", () => {
    const key = "project-mind:todo-rail-draft:workspace";
    const snapshot = {
      content: "准备发布",
      priority: "urgent_important" as const,
      projectId: 7,
      tagIds: [12],
      subtasks: [
        {
          content: "确认发布清单",
          progressDate: "2026-08-23",
          dueDate: "2026-08-24",
        },
      ],
      creationOutcome: "created" as const,
    };

    writeTodoComposerDraft(key, snapshot);

    expect(readTodoComposerDraft(key)).toEqual(snapshot);
  });

  it("clears every Workspace and Project Todo draft without touching other settings", () => {
    window.localStorage.setItem("project-mind:todo-rail-draft:workspace", "workspace draft");
    window.localStorage.setItem("project-mind:todo-rail-draft:7", "project draft");
    window.localStorage.setItem("project-mind:ui", "settings");

    clearAllTodoComposerDrafts();

    expect(window.localStorage.getItem("project-mind:todo-rail-draft:workspace")).toBeNull();
    expect(window.localStorage.getItem("project-mind:todo-rail-draft:7")).toBeNull();
    expect(window.localStorage.getItem("project-mind:ui")).toBe("settings");
  });
});
