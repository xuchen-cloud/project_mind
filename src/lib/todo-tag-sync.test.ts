import { describe, expect, it, vi, afterEach } from "vitest";

import { projectMindApi } from "../services/projectMindApi";
import { resolveTodoContentTagSync } from "./todo-tag-sync";

describe("resolveTodoContentTagSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("merges existing tags and strips hashtag text from todo content", async () => {
    const projectTagSpy = vi.spyOn(projectMindApi, "projectTagUpsert");

    const result = await resolveTodoContentTagSync({
      tagScope: { scope: "project", projectId: 7 },
      content: "联系法务 #审批 并同步 #预算",
      explicitTagIds: [3],
      availableTags: [
        {
          id: 11,
          label: "审批",
          colorKey: "red",
          usageCount: 1,
          createdAt: "2026-04-06T10:00:00.000Z",
          updatedAt: "2026-04-06T10:00:00.000Z",
        },
        {
          id: 13,
          label: "预算",
          colorKey: "green",
          usageCount: 1,
          createdAt: "2026-04-06T10:00:00.000Z",
          updatedAt: "2026-04-06T10:00:00.000Z",
        },
      ],
    });

    expect(result).toEqual({
      content: "联系法务 并同步",
      tagIds: [3, 11, 13],
    });
    expect(projectTagSpy).not.toHaveBeenCalled();
  });

  it("creates missing tags and removes duplicate hashtag tokens", async () => {
    vi.spyOn(projectMindApi, "projectTagSettingsGet").mockResolvedValue({ tags: [] });
    vi.spyOn(projectMindApi, "projectTagUpsert").mockResolvedValue({
      id: 21,
      label: "法务",
      colorKey: "red",
      usageCount: 0,
      createdAt: "2026-04-06T10:00:00.000Z",
      updatedAt: "2026-04-06T10:00:00.000Z",
    });

    const result = await resolveTodoContentTagSync({
      tagScope: { scope: "project", projectId: 9 },
      content: "#法务 跟进合同，再找 #法务",
      explicitTagIds: [],
      availableTags: [],
    });

    expect(result).toEqual({
      content: "跟进合同，再找",
      tagIds: [21],
    });
  });
});
