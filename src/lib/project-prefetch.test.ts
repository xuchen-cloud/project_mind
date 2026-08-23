import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/projectMindApi", () => ({
  projectMindApi: {
    projectPageGet: vi.fn(async ({ projectId }: { projectId: number }) => ({ projectId })),
    projectTagSettingsGet: vi.fn(async ({ projectId }: { projectId: number }) => ({ projectId })),
  },
}));

import { prefetchProjectPageData } from "./project-prefetch";
import { queryKeys } from "./queryKeys";
import { projectMindApi } from "../services/projectMindApi";

describe("prefetchProjectPageData", () => {
  beforeEach(() => vi.clearAllMocks());

  it("warms the canonical project page and tag caches together", async () => {
    const queryClient = new QueryClient();

    await prefetchProjectPageData(queryClient, 7);

    expect(projectMindApi.projectPageGet).toHaveBeenCalledWith({ projectId: 7 });
    expect(projectMindApi.projectTagSettingsGet).toHaveBeenCalledWith({ projectId: 7 });
    expect(queryClient.getQueryData(queryKeys.projectPage(7))).toEqual({ projectId: 7 });
    expect(queryClient.getQueryData(queryKeys.projectTags.project(7))).toEqual({ projectId: 7 });
  });
});
