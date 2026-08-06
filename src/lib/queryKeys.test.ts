import { describe, expect, it } from "vitest";

import { queryKeys } from "./queryKeys";

describe("search query keys", () => {
  it("keeps Workspace and Project Todo search caches distinct", () => {
    expect(queryKeys.search("todo", null)).toEqual([
      "search",
      "workspace",
      null,
      "todo",
    ]);
    expect(queryKeys.search("todo", 3)).toEqual([
      "search",
      "project",
      3,
      "todo",
    ]);
    expect(queryKeys.search("todo", 4)).not.toEqual(queryKeys.search("todo", 3));
  });

  it("names Todo ownership collections separately from the Workspace Rail aggregate", () => {
    expect(queryKeys.todoViews.all).toEqual(["todo-views"]);
    expect(queryKeys.todoViews.workspace).toEqual(["todo-views", "workspace"]);
    expect(queryKeys.todoViews.project(3)).toEqual(["todo-views", "current-project", 3]);
    expect(queryKeys.todoCollections.all).toEqual(["todos"]);
    expect(queryKeys.todoCollections.workspaceOwned).toEqual([
      "todos",
      "workspace-owned",
    ]);
    expect(queryKeys.todoCollections.projectOwned(3)).toEqual([
      "todos",
      "project-owned",
      3,
    ]);
    expect(queryKeys.todoCollections.workspaceRail).toEqual([
      "todos",
      "workspace-rail",
    ]);

    expect(queryKeys.todoCollections.workspaceOwned).not.toEqual(
      queryKeys.todoCollections.workspaceRail,
    );
  });
});
