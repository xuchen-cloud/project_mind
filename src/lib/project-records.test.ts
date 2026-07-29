import { describe, expect, it } from "vitest";

import { filterProjectRecords, parseRecordFilterTagId } from "./project-records";
import type { NoteRecord } from "./types";

function record(
  id: number,
  values: Partial<NoteRecord> = {},
): NoteRecord {
  return {
    id,
    projectId: 1,
    title: null,
    contentMarkdown: "",
    contentHtml: "",
    tags: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...values,
  };
}

describe("parseRecordFilterTagId", () => {
  it("returns null for empty or invalid values", () => {
    expect(parseRecordFilterTagId(null)).toBeNull();
    expect(parseRecordFilterTagId("")).toBeNull();
    expect(parseRecordFilterTagId("abc")).toBeNull();
  });

  it("parses numeric tag ids", () => {
    expect(parseRecordFilterTagId("12")).toBe(12);
  });
});

describe("filterProjectRecords", () => {
  const records = [
    record(1, {
      title: "客户复盘",
      contentMarkdown: "整理 Q2 推进计划",
      tags: [{ id: 1, label: "客户", colorKey: "blue" }],
    }),
    record(2, {
      title: "产品想法",
      contentMarkdown: "离线文件管理",
      tags: [{ id: 2, label: "产品", colorKey: "teal" }],
    }),
  ];

  it("matches title, content, and tag label", () => {
    expect(filterProjectRecords(records, { query: "复盘" }).map((item) => item.id)).toEqual([1]);
    expect(filterProjectRecords(records, { query: "文件" }).map((item) => item.id)).toEqual([2]);
    expect(filterProjectRecords(records, { query: "客户" }).map((item) => item.id)).toEqual([1]);
  });

  it("combines query and tag filters", () => {
    expect(filterProjectRecords(records, { query: "文件", tagId: 1 })).toEqual([]);
    expect(filterProjectRecords(records, { query: "文件", tagId: 2 }).map((item) => item.id)).toEqual([2]);
  });

  it("returns all records when filters are empty", () => {
    expect(filterProjectRecords(records, {}).map((item) => item.id)).toEqual([1, 2]);
  });
});
