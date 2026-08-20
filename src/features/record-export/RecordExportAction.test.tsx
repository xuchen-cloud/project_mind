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
    render(
      <header data-testid="filtered-record-header" style={{ backdropFilter: "blur(16px)" }}>
        <RecordExportAction
          title="阶段总结"
          getCommittedHtml={() => "<p>已保存正文</p>"}
          exportTo={vi.fn()}
        />
      </header>,
    );

    await user.click(screen.getByRole("button", { name: "记录更多操作" }));
    const exportMenuItem = screen.getByRole("menuitem", { name: "导出…" });
    expect(screen.getByTestId("filtered-record-header")).not.toContainElement(exportMenuItem);
    await user.click(exportMenuItem);

    const dialog = screen.getByRole("dialog", { name: "导出 Record" });
    expect(screen.getByTestId("filtered-record-header")).not.toContainElement(dialog);
    expect(screen.getByRole("radio", { name: /Markdown/u })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Word/u })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /PDF/u })).toBeInTheDocument();
  });
});
