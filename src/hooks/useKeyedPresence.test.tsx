import { act, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useKeyedPresence } from "./useKeyedPresence";

type Item = { id: number; label: string };

describe("useKeyedPresence", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("treats initial hydration and filter resets as present content", () => {
    const initial = Array.from({ length: 30 }, (_, index) => ({
      id: index + 1,
      label: `Record ${index + 1}`,
    }));
    const { result, rerender } = renderHook(
      ({ items, resetKey }) => useKeyedPresence(items, (item: Item) => String(item.id), resetKey),
      { initialProps: { items: initial, resetKey: "" } },
    );

    expect(result.current.items).toHaveLength(30);
    expect(result.current.items.every((entry) => entry.state === "present")).toBe(true);

    rerender({ items: [initial[4]], resetKey: "query=Record+5" });
    expect(result.current.items).toEqual([
      { item: initial[4], key: "5", state: "present" },
    ]);
  });

  it("marks only a new id as entering and does not replay entry for content updates", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const first = { id: 1, label: "First" };
    const second = { id: 2, label: "Second" };
    const { result, rerender } = renderHook(
      ({ items }) => useKeyedPresence(items, (item: Item) => String(item.id), ""),
      { initialProps: { items: [first] } },
    );

    rerender({ items: [second, first] });
    expect(result.current.items.map(({ key, state }) => [key, state])).toEqual([
      ["2", "entering"],
      ["1", "present"],
    ]);
    act(() => frames.shift()?.(0));
    expect(result.current.items.every((entry) => entry.state === "present")).toBe(true);

    rerender({ items: [{ ...second, label: "Updated" }, first] });
    expect(result.current.items[0]).toMatchObject({
      key: "2",
      state: "present",
      item: { label: "Updated" },
    });
  });

  it("retains a deleted id for 160ms and cancels exit when that id returns", () => {
    vi.useFakeTimers();
    const item = { id: 1, label: "Record" };
    const { result, rerender } = renderHook(
      ({ items }) => useKeyedPresence(items, (entry: Item) => String(entry.id), ""),
      { initialProps: { items: [item] } },
    );

    rerender({ items: [] });
    expect(result.current.items[0]).toMatchObject({ key: "1", state: "exiting" });
    act(() => vi.advanceTimersByTime(159));
    expect(result.current.items).toHaveLength(1);

    rerender({ items: [{ ...item, label: "Restored" }] });
    expect(result.current.items[0]).toMatchObject({
      key: "1",
      state: "present",
      item: { label: "Restored" },
    });
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.items).toHaveLength(1);

    rerender({ items: [] });
    act(() => vi.advanceTimersByTime(160));
    expect(result.current.items).toEqual([]);
  });

  it("finishes an exiting id from the rendered transition before the timer fallback", () => {
    vi.useFakeTimers();
    const item = { id: 1, label: "Record" };
    const { result, rerender } = renderHook(
      ({ items }) => useKeyedPresence(items, (entry: Item) => String(entry.id), ""),
      { initialProps: { items: [item] } },
    );

    rerender({ items: [] });
    act(() => result.current.finishExit("1"));

    expect(result.current.items).toEqual([]);
    act(() => vi.advanceTimersByTime(160));
    expect(result.current.items).toEqual([]);
  });

  it("cancels list layout work after an empty list becomes populated and unmounts", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 17);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");

    function Harness({ items }: { items: Item[] }) {
      const presence = useKeyedPresence(items, (item) => String(item.id), "");
      if (presence.items.length === 0) return null;
      return (
        <div ref={presence.containerRef} data-list-layout-motion>
          {presence.items.map((entry) => (
            <div key={entry.key} data-layout-motion-id={`record-${entry.key}`} />
          ))}
        </div>
      );
    }

    const view = render(<Harness items={[]} />);
    view.rerender(<Harness items={[{ id: 1, label: "Record" }]} />);
    view.unmount();

    expect(cancelFrame).toHaveBeenCalledWith(17);
  });
});
