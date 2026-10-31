import { describe, expect, it } from "vitest";
import { sortPinnedByUpdatedAt } from "./list-order";

describe("list ordering", () => {
  it("breaks timestamp ties by descending ID without changing its input", () => {
    const items = Object.freeze([
      Object.freeze({ id: 1, updatedAt: "2026-10-01T00:00:00Z" }),
      Object.freeze({ id: 2, updatedAt: "2026-10-01T00:00:00Z" }),
      Object.freeze({ id: 3, updatedAt: "2026-10-01T00:00:00Z" }),
      Object.freeze({ id: 4, updatedAt: "2026-10-01T00:00:00Z" }),
    ]);
    const result = sortPinnedByUpdatedAt(items, [1, 2]);
    expect(result.map(item => item.id)).toEqual([2, 1, 4, 3]);
    expect(items.map(item => item.id)).toEqual([1, 2, 3, 4]);
    expect(result).not.toBe(items);
    expect(result[0]).toBe(items[1]);
  });

  it("puts pins first and sorts both groups by their latest modification", () => {
    const items = [
      { id: 1, updatedAt: "2026-10-01T00:00:00Z" },
      { id: 2, updatedAt: "2026-10-03T00:00:00Z" },
      { id: 3, updatedAt: "2026-10-02T00:00:00Z" },
      { id: 4, updatedAt: "2026-10-04T00:00:00Z" },
    ];
    expect(sortPinnedByUpdatedAt(items, [3, 1]).map(item => item.id)).toEqual([3, 1, 4, 2]);
  });
});
