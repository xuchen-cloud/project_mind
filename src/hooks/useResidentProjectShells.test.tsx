import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

describe("QuickNote eviction barrier", () => {
  it("retains an Overview until its draft saves, and retains it after failure", async () => {
    let reject!: (reason: Error) => void;
    let resolve!: () => void;
    let barrier = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const prepareEviction = vi.fn(() => barrier);
    const openProjectIds = [1, 2, 3, 4, 5, 6];
    const { result, rerender } = renderHook(({ activeProjectId }) => useResidentProjectShells({
      activeProjectId, enabled: true, hasWorkspace: true, openProjectIds, prepareEviction,
    }), { initialProps: { activeProjectId: 1 } });
    for (const activeProjectId of [2, 3, 4, 5, 6]) rerender({ activeProjectId });
    expect(prepareEviction).toHaveBeenCalledWith(1);
    expect(result.current).toContain(1);
    await act(async () => reject(new Error("storage failure")));
    expect(result.current).toContain(1);
    barrier = new Promise<void>(done => { resolve = done; });
    rerender({ activeProjectId: 5 });
    expect(result.current).toContain(1);
    await act(async () => resolve());
    await waitFor(() => expect(result.current).not.toContain(1));
    expect(result.current).toHaveLength(5);
  });
});

it("does not evict a reactivated Overview when its previous save finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const prepareEviction = vi.fn((id: number) => id === 1 ? gate : Promise.resolve());
  const { result, rerender } = renderHook(({ activeProjectId }) => useResidentProjectShells({
    activeProjectId, enabled: true, hasWorkspace: true, openProjectIds: [1, 2, 3, 4, 5, 6], prepareEviction,
  }), { initialProps: { activeProjectId: 1 } });
  for (const activeProjectId of [2, 3, 4, 5, 6]) rerender({ activeProjectId });
  expect(prepareEviction).toHaveBeenCalledWith(1);
  rerender({ activeProjectId: 1 });
  await act(async () => release());
  expect(result.current).toContain(1);
  expect(result.current.at(-1)).toBe(1);
});
