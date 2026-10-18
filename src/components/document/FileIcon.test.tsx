import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../../services/desktopApi";
import { createProjectMindQueryClient } from "../../lib/queryClient";
import { FileIcon } from "./FileIcon";
import iconStyles from "./file-icon.css?inline";
import iconTheme from "@project-mind/dsh-ui/file-icons/styles.css?inline";

vi.mock("../../services/desktopApi", () => ({ desktopApi: { fileCommand: vi.fn() } }));

function renderIcon(name: string, size = 16, className?: string) {
  const client = createProjectMindQueryClient();
  const wrap = (nextName: string) => (
    <QueryClientProvider client={client}>
      <FileIcon name={nextName} size={size} className={className} />
    </QueryClientProvider>
  );
  return { ...render(wrap(name)), wrap, client };
}

function deferredIcon() {
  let resolve!: (icon: string | null) => void;
  const promise = new Promise<string | null>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleIcon(pending: ReturnType<typeof deferredIcon>, png: string) {
  await act(async () => {
    pending.resolve(png);
    await pending.promise;
    // React Query schedules observer notifications on the next tick.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("FileIcon", () => {
  beforeEach(() => { vi.mocked(desktopApi.fileCommand).mockReset(); });

  it.each(["report.docx", "sheet.xlsx", "slides.pptx", "main.ts", "Dockerfile"])(
    "uses the decorative DSH glyph for %s without a native lookup",
    (name) => {
      const { container } = renderIcon(name, 24, "sidebar-icon");
      const glyph = container.querySelector("svg");
      expect(glyph).toHaveAttribute("width", "24");
      expect(glyph).toHaveAttribute("height", "24");
      expect(glyph).toHaveAttribute("aria-hidden", "true");
      expect(container.firstElementChild).toHaveClass("sidebar-icon");
      expect(container.querySelector("img")).toBeNull();
      expect(desktopApi.fileCommand).not.toHaveBeenCalled();
    },
  );

  it("loads an unknown type's native PNG as a decorative image", async () => {
    const png = "data:image/png;base64,bmF0aXZl";
    vi.mocked(desktopApi.fileCommand).mockResolvedValue(png);
    const { container } = renderIcon("drawing.custom");
    await waitFor(() => expect(container.querySelector("img")).toHaveAttribute("src", png));
    expect(desktopApi.fileCommand).toHaveBeenCalledExactlyOnceWith("desktop_file_type_icon", { name: "drawing.custom" });
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("svg")).toBeNull();
  });

  it("shows a neutral, explicitly loading placeholder while a system lookup is pending", () => {
    vi.mocked(desktopApi.fileCommand).mockImplementation(() => new Promise(() => {}));
    const { container } = renderIcon("archive.unknown");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[title='正在加载系统文件类型图标']")).not.toBeNull();
    expect(container.querySelector("[data-file-type-mark]")).toBeNull();
  });

  it("makes native lookup failure observable without a broken image or a mapped glyph", async () => {
    vi.mocked(desktopApi.fileCommand).mockRejectedValue(new Error("OS icon lookup failed"));
    const { container } = renderIcon("archive.unknown");
    await waitFor(() => expect(container.querySelector("[title='无法加载系统文件类型图标']")).not.toBeNull());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[data-file-type-mark]")).toBeNull();
    expect(desktopApi.fileCommand).toHaveBeenCalledTimes(1);
  });

  it("explains a null system icon with the neutral placeholder", async () => {
    vi.mocked(desktopApi.fileCommand).mockResolvedValue(null);
    const { container } = renderIcon("archive.unknown");
    await waitFor(() => expect(container.querySelector("[title='系统未提供文件类型图标']")).not.toBeNull());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-file-type-mark]")).toBeNull();
  });

  it.each(["pending", "ready"])("never displays a late first unknown type result when the second type is %s", async (secondState) => {
    const old = deferredIcon();
    const current = deferredIcon();
    const oldPng = "data:image/png;base64,b2xk";
    const currentPng = "data:image/png;base64,Y3VycmVudA==";
    vi.mocked(desktopApi.fileCommand).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    const view = renderIcon("first.custom");
    const displayedSources: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof HTMLImageElement) {
          displayedSources.push(record.oldValue ?? "", record.target.getAttribute("src") ?? "");
        }
        for (const node of record.addedNodes) {
          if (node instanceof HTMLImageElement) displayedSources.push(node.getAttribute("src") ?? "");
        }
      }
    });
    observer.observe(view.container, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"], attributeOldValue: true });
    try {
      view.rerender(view.wrap("second.unknown"));
      expect(desktopApi.fileCommand).toHaveBeenNthCalledWith(1, "desktop_file_type_icon", { name: "first.custom" });
      expect(desktopApi.fileCommand).toHaveBeenNthCalledWith(2, "desktop_file_type_icon", { name: "second.unknown" });
      if (secondState === "ready") {
        await settleIcon(current, currentPng);
        await waitFor(() => expect(view.container.querySelector("img")).toHaveAttribute("src", currentPng));
      }
      await settleIcon(old, oldPng);
      if (secondState === "pending") {
        expect(view.container.querySelector("img")).toBeNull();
        expect(view.container.querySelector("[title='正在加载系统文件类型图标']")).not.toBeNull();
        await settleIcon(current, currentPng);
      }
      await waitFor(() => expect(view.container.querySelector("img")).toHaveAttribute("src", currentPng));
      expect(displayedSources).toContain(currentPng);
      expect(displayedSources).not.toContain(oldPng);
      expect(desktopApi.fileCommand).toHaveBeenCalledTimes(2);
    } finally {
      observer.disconnect();
    }
  });

  it("clears an already loaded image immediately when the unknown type changes", async () => {
    const current = deferredIcon();
    vi.mocked(desktopApi.fileCommand).mockResolvedValueOnce("data:image/png;base64,b2xk").mockImplementationOnce(() => current.promise);
    const view = renderIcon("first.custom");
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    view.rerender(view.wrap("second.unknown"));
    expect(view.container.querySelector("img")).toBeNull();
    await settleIcon(current, "data:image/png;base64,Y3VycmVudA==");
    await waitFor(() => expect(view.container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,Y3VycmVudA=="));
  });

  it("keeps the mapped glyph when switching from a pending unknown lookup", async () => {
    const old = deferredIcon();
    vi.mocked(desktopApi.fileCommand).mockImplementation(() => old.promise);
    const view = renderIcon("first.custom");
    view.rerender(view.wrap("report.docx"));
    await settleIcon(old, "data:image/png;base64,b2xk");
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("[data-file-type-mark]")).not.toBeNull();
    expect(view.container.querySelector("[title]")).toBeNull();
    expect(desktopApi.fileCommand).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent same-extension lookups and reuses their cached type icon", async () => {
    const pending = deferredIcon();
    vi.mocked(desktopApi.fileCommand).mockImplementation(() => pending.promise);
    const view = renderIcon("first.custom");
    const second = render(<QueryClientProvider client={view.client}><FileIcon name="second.CUSTOM" /></QueryClientProvider>);
    expect(desktopApi.fileCommand).toHaveBeenCalledTimes(1);
    await settleIcon(pending, "data:image/png;base64,c2hhcmVk");
    await waitFor(() => expect(second.container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,c2hhcmVk"));
    expect(view.container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,c2hhcmVk");
    view.unmount();
    second.unmount();
    const reopened = render(<QueryClientProvider client={view.client}><FileIcon name="third.custom" /></QueryClientProvider>);
    expect(reopened.container.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,c2hhcmVk");
    expect(desktopApi.fileCommand).toHaveBeenCalledTimes(1);
  });

  it("provides the exact DSH static palette and fixed flex size outside a DSH host", () => {
    const style = document.createElement("style");
    style.textContent = `${iconTheme}\n${iconStyles}`;
    document.head.append(style);
    try {
      const { container } = renderIcon("report.docx", 22);
      const icon = container.firstElementChild!;
      expect(icon.closest(".dsh-ui-host")).toBeNull();
      const css = getComputedStyle(icon);
      expect(css.width).toBe("22px");
      expect(css.height).toBe("22px");
      expect(css.flexShrink).toBe("0");
      const palette = {
        "--dsw-static-amber-500": "rgb(245, 158, 11)",
        "--dsw-static-deepseek-450": "rgb(86, 134, 254)",
        "--dsw-static-deepseek-500": "rgb(65, 118, 230)",
        "--dsw-static-green-500": "rgb(34, 197, 94)",
        "--dsw-static-neutral-00": "rgb(255, 255, 255)",
        "--dsw-static-neutral-400": "rgb(162, 164, 166)",
        "--dsw-static-neutral-bluish-300": "rgb(207, 211, 214)",
        "--dsw-static-red-600": "rgb(236, 19, 19)",
      };
      for (const [token, value] of Object.entries(palette)) {
        // CSSOM versions differ in optional whitespace after RGB commas.
        expect(css.getPropertyValue(token).trim().replace(/,\s*/gu, ",")).toBe(value.replace(/,\s*/gu, ","));
      }
    } finally {
      style.remove();
    }
  });
});
