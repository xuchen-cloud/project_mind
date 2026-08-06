import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const openTodoUrl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("./todo-urls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./todo-urls")>()),
  openTodoUrl,
}));

import { InternalReferenceInlineText } from "../internal-reference";

describe("Todo URL display", () => {
  it("composes URL links with structured tokens and opens them in the system browser", async () => {
    const user = userEvent.setup();
    render(
      <InternalReferenceInlineText
        value="查看 [[todo:7|Alpha Todo]] 和 https://example.com/docs。"
        variant="todo-inline"
      />,
    );

    expect(screen.getByText("Alpha Todo")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "https://example.com/docs" });
    await user.click(link);

    expect(openTodoUrl).toHaveBeenCalledWith("https://example.com/docs");
  });
});
