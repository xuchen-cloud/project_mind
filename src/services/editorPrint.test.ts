import { beforeEach, describe, expect, it, vi } from "vitest";
import { printEditorHtml, renderEditorPdf } from "./editorPrint";

const { printEditorHtml: nativePrint, renderEditorPdf: nativePdf } = vi.hoisted(() => ({ printEditorHtml: vi.fn(), renderEditorPdf: vi.fn() }));
vi.mock("./desktopApi", () => ({ desktopApi: { printEditorHtml: nativePrint, renderEditorPdf: nativePdf } }));

describe("printEditorHtml", () => {
  beforeEach(() => { nativePrint.mockReset(); nativePdf.mockReset(); });

  it("passes the complete format document to the native host unchanged", async () => {
    const input = {
      html: '<!doctype html><style>@page{size:A4}</style><img src="data:image/png;base64,AAAA"><p>中文</p>',
      title: "项目材料.xlsx",
      pageSize: {widthPt: 841.89, heightPt: 595.28},
    };
    nativePrint.mockResolvedValue(undefined);
    await expect(printEditorHtml(input)).resolves.toBeUndefined();
    expect(nativePrint).toHaveBeenCalledExactlyOnceWith(input);
  });

  it("waits for the native interaction instead of claiming dispatch is completion", async () => {
    let finish!: () => void;
    nativePrint.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const completed = vi.fn();
    const result = printEditorHtml({ html: "<p>Document</p>" }).then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    finish();
    await result;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("preserves native failures without a browser print fallback", async () => {
    const error = "打印文档加载超时";
    const browserPrint = vi.spyOn(window, "print").mockImplementation(() => {});
    nativePrint.mockRejectedValue(error);
    try {
      await expect(printEditorHtml({ html: "<p>Document</p>" })).rejects.toBe(error);
      expect(browserPrint).not.toHaveBeenCalled();
    } finally {
      browserPrint.mockRestore();
    }
  });
});

it("returns exact binary PDF bytes after the native renderer completes", async () => {
  const input = { html: "<style>@page{size:A4}</style><p>中文</p>" };
  const pdf = "%PDF-1.7\r\n%\x80\xff\x00";
  let finish!: (encoded: string) => void;
  nativePdf.mockReturnValue(new Promise<string>(resolve => { finish = resolve; }));
  const completed = vi.fn();
  const result = renderEditorPdf(input).then(completed);
  await Promise.resolve();
  expect(completed).not.toHaveBeenCalled();
  expect(nativePdf).toHaveBeenCalledExactlyOnceWith(input);
  finish(btoa(pdf));
  await result;
  expect(completed).toHaveBeenCalledWith(Uint8Array.from(pdf, character => character.charCodeAt(0)));
});

it("propagates native PDF rendering failure without manufacturing output", async () => {
  nativePdf.mockRejectedValue("PDF 排版失败");
  await expect(renderEditorPdf({ html: "<p>正文</p>" })).rejects.toBe("PDF 排版失败");
});
