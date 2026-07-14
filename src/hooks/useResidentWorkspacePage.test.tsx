import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useResidentWorkspacePage } from "./useResidentWorkspacePage";

describe("useResidentWorkspacePage", () => {
  it("keeps Workspace pinned after navigating through project pages", () => {
    const { result, rerender } = renderHook(
      (props: { active: boolean; enabled: boolean; workspaceKey: string | null }) =>
        useResidentWorkspacePage(props),
      {
        initialProps: {
          active: true,
          enabled: true,
          workspaceKey: "/workspace/one",
        },
      },
    );

    expect(result.current).toBe(true);

    rerender({ active: false, enabled: true, workspaceKey: "/workspace/one" });
    expect(result.current).toBe(true);

    rerender({ active: true, enabled: true, workspaceKey: "/workspace/one" });
    rerender({ active: false, enabled: true, workspaceKey: "/workspace/one" });
    expect(result.current).toBe(true);
  });

  it("clears the pinned page when its workspace scope is removed or changed", () => {
    const { result, rerender } = renderHook(
      (props: { active: boolean; enabled: boolean; workspaceKey: string | null }) =>
        useResidentWorkspacePage(props),
      {
        initialProps: {
          active: true,
          enabled: true,
          workspaceKey: "/workspace/one",
        },
      },
    );

    rerender({ active: false, enabled: true, workspaceKey: null });
    expect(result.current).toBe(false);

    rerender({ active: true, enabled: true, workspaceKey: "/workspace/one" });
    rerender({ active: false, enabled: true, workspaceKey: "/workspace/two" });
    expect(result.current).toBe(false);

    rerender({ active: false, enabled: false, workspaceKey: "/workspace/two" });
    expect(result.current).toBe(false);
  });
});
