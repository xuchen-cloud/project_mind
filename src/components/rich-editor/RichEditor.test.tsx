import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RichEditor } from "./RichEditor";

describe("RichEditor tables", () => {
  it("inserts a selected table size and reveals the table toolbar", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(<RichEditor variant="toolbar" onChange={onChange} />);

    await user.click(await screen.findByLabelText("表格"));
    await user.click(screen.getByLabelText("插入 2 行 4 列表格"));

    await waitFor(() => {
      expect(container.querySelectorAll("table tr")).toHaveLength(2);
    });

    expect(container.querySelectorAll("table tr")[0]?.querySelectorAll("th")).toHaveLength(4);
    expect(await screen.findByLabelText("表格工具栏")).toBeInTheDocument();
    expect(screen.getByLabelText("下方插入行")).toBeInTheDocument();
    expect(screen.getByLabelText("删除表格")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalled();
  });

  it("adds rows from the contextual table toolbar", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="toolbar" />);

    await user.click(await screen.findByLabelText("表格"));
    await user.click(screen.getByLabelText("插入 2 行 2 列表格"));
    await user.click(await screen.findByLabelText("下方插入行"));

    await waitFor(() => {
      expect(container.querySelectorAll("table tr")).toHaveLength(3);
    });
  });

  it("shows a compact table action for focused bare editors", async () => {
    const user = userEvent.setup();
    const { container } = render(<RichEditor variant="bare" />);

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".rich-editor__surface");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    fireEvent.focus(surface);
    await user.click(await screen.findByRole("button", { name: "插入表格" }));
    await user.click(screen.getByLabelText("插入 1 行 2 列表格"));

    await waitFor(() => {
      expect(container.querySelectorAll("table tr")).toHaveLength(1);
    });
  });

  it("hides the compact table action when tables are disabled", async () => {
    const { container } = render(<RichEditor variant="bare" enableTables={false} />);

    const surface = await waitFor(() => {
      const nextSurface = container.querySelector(".rich-editor__surface");

      expect(nextSurface).toBeTruthy();
      return nextSurface as HTMLElement;
    });

    fireEvent.focus(surface);

    expect(screen.queryByRole("button", { name: "插入表格" })).not.toBeInTheDocument();
  });
});
