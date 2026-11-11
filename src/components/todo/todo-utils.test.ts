import { describe, expect, it } from "vitest";

import { formatFullDate, formatMonthDay, parseProgressInput } from "./todo-utils";

describe("Todo date formatting", () => {
  it.each([
    ["2026-11-11", "11月11日"],
    ["2026-01-01", "1月1日"],
    ["2024-02-29", "2月29日"],
    ["2026-03-08", "3月8日"],
  ])("preserves the calendar date %s in the process timezone", (value, monthDay) => {
    expect(formatMonthDay(value)).toBe(monthDay);
    expect(formatFullDate(value)).toBe(value);
  });

  it("continues to format timestamps in local time", () => {
    const value = new Date(2026, 10, 11, 12).toISOString();
    expect(formatMonthDay(value)).toBe("11月11日");
    expect(formatFullDate(value)).toBe("2026-11-11");
  });

  it("preserves unparseable input", () => {
    expect(formatMonthDay("invalid")).toBe("invalid");
    expect(formatFullDate("invalid")).toBe("invalid");
  });
});

describe("parseProgressInput", () => {
  const now = new Date(2026, 6, 14);

  it("parses a four-digit month-day prefix using the current year", () => {
    expect(parseProgressInput("@0315 提交方案", now)).toEqual({
      ok: true,
      progressDate: "2026-07-14",
      dueDate: "2026-03-15",
      content: "提交方案",
    });
  });

  it("parses an eight-digit year-month-day prefix", () => {
    expect(parseProgressInput("@20270315 提交方案", now)).toEqual({
      ok: true,
      progressDate: "2026-07-14",
      dueDate: "2027-03-15",
      content: "提交方案",
    });
  });

  it("removes a standalone due date from the middle or end of the content", () => {
    expect(parseProgressInput("提交 @0315 最终方案", now)).toMatchObject({
      dueDate: "2026-03-15",
      content: "提交 最终方案",
    });
    expect(parseProgressInput("提交最终方案@20270315", now)).toMatchObject({
      dueDate: "2027-03-15",
      content: "提交最终方案",
    });
  });

  it("treats other all-numeric @ prefixes as invalid dates", () => {
    expect(parseProgressInput("@315 提交方案", now)).toEqual({
      ok: false,
      error: "日期格式无效，请使用 @MMDD 或 @YYYYMMDD，例如 @0315 或 @20270315。",
    });
  });

  it("rejects invalid calendar dates in either supported format", () => {
    expect(parseProgressInput("@0230 提交方案", now).ok).toBe(false);
    expect(parseProgressInput("@20270229 提交方案", now).ok).toBe(false);
  });
});
