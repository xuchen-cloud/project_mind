import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RecordExportAction } from "./RecordExportAction";

vi.mock("../../services/desktopApi", () => ({
  desktopApi: {
    openFile: vi.fn(),
    revealPath: vi.fn(),
    saveExportFile: vi.fn(),
    exportPathExists: vi.fn(),
    nextAvailableExportPath: vi.fn(),
  },
}));

describe("RecordExportAction", () => {
  it("opens the format dialog from the Record more-actions menu", async () => {
    const user = userEvent.setup();
    render(<RecordExportAction
      title="阶段总结"
      getCommittedHtml={() => "<p>已保存正文</p>"}
      exportTo={vi.fn()}
    />);

    await user.click(screen.getByRole("button", { name: "记录更多操作" }));
    await user.click(screen.getByRole("menuitem", { name: "导出…" }));

    expect(screen.getByRole("dialog", { name: "导出 Record" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Markdown/u })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Word/u })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /PDF/u })).toBeInTheDocument();
  });
});
