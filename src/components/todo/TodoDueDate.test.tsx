import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TodoDueDate } from "./TodoDueDate";

describe("TodoDueDate", () => {
  it.each([
    ["2026-11-11", "11月11日"],
    ["2026-01-01", "1月1日"],
    ["2024-02-29", "2月29日"],
    ["2026-03-08", "3月8日"],
  ])("displays %s consistently in text and accessible metadata", (value, monthDay) => {
    render(<TodoDueDate value={value} />);

    const date = screen.getByLabelText(`截止日期 ${value}`);
    expect(date.tagName).toBe("TIME");
    expect(date).toHaveTextContent(monthDay);
    expect(date).toHaveAttribute("datetime", value);
    expect(date).toHaveAttribute("title", `截止日期：${value}`);
    expect(date.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
