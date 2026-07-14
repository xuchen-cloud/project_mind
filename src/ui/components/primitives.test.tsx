import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Search } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import {
  Button,
  Dialog,
  IconButton,
  SearchField,
  StatusBadge,
  TextField,
  ToolbarButton,
} from "./index";

describe("ui primitives", () => {
  it("renders button variants with icons", () => {
    render(
      <Button variant="primary" leadingIcon={<Search size={14} />}>
        Search
      </Button>,
    );

    const button = screen.getByRole("button", { name: /search/i });
    expect(button).toHaveClass("bg-text");
  });

  it("renders text and search fields", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <TextField aria-label="title" placeholder="Title" />
        <SearchField aria-label="search" placeholder="Search here" />
      </div>,
    );

    await user.type(screen.getByLabelText("title"), "Alpha");
    await user.type(screen.getByLabelText("search"), "todo");

    expect(screen.getByLabelText("title")).toHaveValue("Alpha");
    expect(screen.getByLabelText("search")).toHaveValue("todo");
  });

  it("renders icon buttons, dialogs, badges, and toolbar buttons", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <div>
        <IconButton aria-label="settings">
          <Search size={14} />
        </IconButton>
        <StatusBadge tone="warning">warning</StatusBadge>
        <ToolbarButton aria-label="toolbar" active>
          <Search size={14} />
        </ToolbarButton>
        <Dialog open title="Dialog Title" description="Dialog copy" onClose={onClose}>
          <div>Dialog body</div>
        </Dialog>
      </div>,
    );

    expect(screen.getByText("Dialog body")).toBeInTheDocument();
    expect(screen.getByText("warning")).toHaveClass("text-warning");
    expect(screen.getByLabelText("toolbar")).toHaveClass("text-accent");

    await user.click(screen.getByLabelText("关闭对话框"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("supports raising a dialog above another modal layer", () => {
    render(
      <Dialog open title="Nested Dialog" onClose={() => undefined} layerClassName="z-[60]">
        <div>Nested dialog body</div>
      </Dialog>,
    );

    expect(screen.getByRole("dialog", { name: "Nested Dialog" }).parentElement).toHaveClass(
      "z-[60]",
    );
  });
});
