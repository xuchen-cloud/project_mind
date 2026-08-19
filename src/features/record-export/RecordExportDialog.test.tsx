import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RecordExportDialog } from "./RecordExportDialog";

function renderDialog(overrides: Partial<Parameters<typeof RecordExportDialog>[0]> = {}) {
  const props: Parameters<typeof RecordExportDialog>[0] = {
    open: true,
    hasImages: true,
    onClose: vi.fn(),
    chooseTarget: vi.fn(async () => ({ path: "/tmp/记录.zip", overwrite: false })),
    exportTo: vi.fn(async () => ({ kind: "success", path: "/tmp/记录.zip", warnings: [], fontSubstituted: false })),
    onOpenFile: vi.fn(),
    onRevealFile: vi.fn(),
    ...overrides,
  };
  render(<RecordExportDialog {...props} />);
  return props;
}

describe("RecordExportDialog thin UI boundary", () => {
  it("defaults to Markdown with images and forwards an explicit format request", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    expect(screen.getByRole("radio", { name: "Markdown" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /包含图片/ })).toBeChecked();
    await user.click(screen.getByRole("radio", { name: "Word (.docx)" }));
    await user.click(screen.getByRole("button", { name: "导出" }));

    await waitFor(() => expect(props.exportTo).toHaveBeenCalled());
    expect(props.chooseTarget).toHaveBeenCalledWith("docx", true);
    expect(props.exportTo).toHaveBeenCalledWith(expect.objectContaining({ format: "docx", includeImages: true }));
    expect(await screen.findByText("导出完成")).toBeInTheDocument();
  });

  it("pauses on missing images and resumes the same target with placeholders", async () => {
    const user = userEvent.setup();
    const exportTo = vi.fn()
      .mockResolvedValueOnce({ kind: "missing-images", missing: [{ label: "白板", reason: "文件不存在" }] })
      .mockResolvedValueOnce({ kind: "success", path: "/tmp/记录.zip", warnings: ["1 张图片未能导出"], fontSubstituted: false });
    const props = renderDialog({ exportTo });

    await user.click(screen.getByRole("button", { name: "导出" }));
    expect(await screen.findByText(/白板：文件不存在/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "继续生成占位版本" }));

    await waitFor(() => expect(exportTo).toHaveBeenCalledTimes(2));
    expect(props.chooseTarget).toHaveBeenCalledTimes(1);
    expect(exportTo.mock.calls[1][0]).toEqual(expect.objectContaining({ missingImageBehavior: "placeholder", targetPath: "/tmp/记录.zip" }));
  });

  it("aborts a running export when the user cancels", async () => {
    const user = userEvent.setup();
    let requestSignal: AbortSignal | undefined;
    renderDialog({
      exportTo: vi.fn((request) => {
        requestSignal = request.signal;
        request.onProgress?.({ stage: "writing" });
        return new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError"))));
      }),
    });

    await user.click(screen.getByRole("button", { name: "导出" }));
    await user.click(await screen.findByRole("button", { name: "取消导出" }));
    expect(requestSignal?.aborted).toBe(true);
    expect(await screen.findByText(/导出已取消/)).toBeInTheDocument();
  });

  it("shows save failures without reporting success or opening a file", async () => {
    const user = userEvent.setup();
    const props = renderDialog({ exportTo: vi.fn(async () => { throw new Error("导出前保存失败"); }) });

    await user.click(screen.getByRole("button", { name: "导出" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("导出前保存失败");
    expect(screen.queryByText("导出完成")).not.toBeInTheDocument();
    expect(props.onOpenFile).not.toHaveBeenCalled();
    expect(props.onRevealFile).not.toHaveBeenCalled();
  });

  it("offers explicit open and reveal actions only after completion", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole("button", { name: "导出" }));
    await user.click(await screen.findByRole("button", { name: "打开文件" }));
    await user.click(screen.getByRole("button", { name: "在文件管理器中显示" }));

    expect(props.onOpenFile).toHaveBeenCalledWith("/tmp/记录.zip");
    expect(props.onRevealFile).toHaveBeenCalledWith("/tmp/记录.zip");
  });
});
