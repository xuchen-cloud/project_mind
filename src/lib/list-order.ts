/** Pins affect presentation only; each group follows the content's modification time. */
export function sortPinnedByUpdatedAt<T extends { id: number; updatedAt: string }>(
  items: readonly T[], pinnedIds: readonly number[],
): T[] {
  const pins = new Set(pinnedIds);
  return [...items].sort((a, b) => Number(pins.has(b.id)) - Number(pins.has(a.id))
    || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id - a.id);
}
