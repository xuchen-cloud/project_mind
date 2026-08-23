import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useResidentProjectShells } from "./useResidentProjectShells";

describe("useResidentProjectShells", () => {
  it("includes a newly active cold project in the route-change render", () => {
    const openProjectIds = [1, 2, 3, 4];
    const { result, rerender } = renderHook(
      ({ activeProjectId }) =>
        useResidentProjectShells({
          activeProjectId,
          enabled: true,
          hasWorkspace: true,
          openProjectIds,
        }),
      { initialProps: { activeProjectId: 1 } },
    );

    expect(result.current).toContain(1);
    rerender({ activeProjectId: 4 });
    expect(result.current.at(-1)).toBe(4);
  });
});
