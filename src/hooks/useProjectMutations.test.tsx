import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import { queryKeys } from "../lib/queryKeys";

const apiMocks = vi.hoisted(() => ({
  projectSetArchive: vi.fn(),
}));

vi.mock("../services/projectMindApi", () => ({
  projectMindApi: {
    projectSetArchive: apiMocks.projectSetArchive,
  },
}));

vi.mock("../state/feedback-store", () => ({
  useFeedbackStore: () => ({
    pushToast: vi.fn(),
    setStatus: vi.fn(),
  }),
}));

vi.mock("../state/ui-store", () => ({
  useUiStore: () => ({
    setCreateProjectOpen: vi.fn(),
  }),
}));

import { useProjectMutations } from "./useProjectMutations";

describe("useProjectMutations", () => {
  it("invalidates the Workspace Page when a Project is archived", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.workspacePage, {
      quickNote: null,
      records: [],
      unfinishedTodos: [{ id: 7, projectId: 1 }],
      finishedTodos: [],
    });
    apiMocks.projectSetArchive.mockResolvedValueOnce({
      id: 1,
      name: "Alpha",
      isArchived: true,
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useProjectMutations([], vi.fn()), { wrapper });

    await act(async () => {
      await result.current.archiveMutation.mutateAsync({
        projectId: 1,
        isArchived: true,
      });
    });

    expect(queryClient.getQueryState(queryKeys.workspacePage)?.isInvalidated).toBe(true);
  });
});
