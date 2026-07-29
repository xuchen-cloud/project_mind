import type { NoteRecord } from "./types";

export function parseRecordFilterTagId(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function filterProjectRecords(
  records: NoteRecord[],
  options: {
    query?: string | null;
    tagId?: number | null;
  },
) {
  const normalizedQuery = (options.query ?? "").trim().toLocaleLowerCase("zh-Hans-CN");
  const tagId = options.tagId ?? null;

  return records.filter((record) => {
    const tags = record.tags ?? [];
    const matchesQuery =
      !normalizedQuery ||
      (record.title ?? "").toLocaleLowerCase("zh-Hans-CN").includes(normalizedQuery) ||
      record.contentMarkdown.toLocaleLowerCase("zh-Hans-CN").includes(normalizedQuery) ||
      tags.some((tag) =>
        tag.label.toLocaleLowerCase("zh-Hans-CN").includes(normalizedQuery),
      );
    const matchesTag = tagId === null || tags.some((tag) => tag.id === tagId);

    return matchesQuery && matchesTag;
  });
}
