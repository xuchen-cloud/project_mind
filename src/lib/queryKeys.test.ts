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
});
