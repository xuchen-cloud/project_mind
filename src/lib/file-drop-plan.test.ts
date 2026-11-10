import { describe, expect, it } from "vitest";
import { planFileDrop } from "./file-drop-plan";

describe("file drop intent", () => {
  it("imports a quick or blank drop without inferring a version target", () => {
    expect(planFileDrop(["/inbox/report.docx"], null)).toEqual({
      kind: "import", paths: ["/inbox/report.docx"],
    });
  });

  it("updates the exact visible target with a differently named file of the same format", () => {
    const target = { id: 42, name: "draft.DOCX", versionNumber: 2 };
    expect(planFileDrop(["C:\\inbox\\review.docx"], target)).toEqual({
      kind: "update", sourcePath: "C:\\inbox\\review.docx", target,
    });
  });

  it("rejects multiple files on a ready row without guessing which one replaces it", () => {
    expect(planFileDrop(["/inbox/a.docx", "/inbox/b.docx"], { id: 42, name: "draft.docx" })).toEqual({
      kind: "reject", message: "更新版本一次只能选择一个文件。请拖到空白处新增多个文件。",
    });
  });

  it.each(["/inbox/report.xlsx", "/inbox/README", "/inbox/.docx"])("rejects an incompatible or unknown format: %s", sourcePath => {
    expect(planFileDrop([sourcePath], { id: 42, name: "draft.docx" })).toEqual({
      kind: "reject", message: "文件格式不兼容。请拖到空白处新增文件。",
    });
  });

  it.each([
    ["C:\\inbox\\photo.JPEG", "photo.jpg"],
    ["/inbox/scan.tiff", "scan.tif"],
    ["/inbox/review.markdown", "draft.md"],
  ])("accepts a spelling of the same format: %s → %s", (sourcePath, name) => {
    const target = { id: 42, name };
    expect(planFileDrop([sourcePath], target)).toEqual({ kind: "update", sourcePath, target });
  });

  it("deduplicates an identical source path before import or update", () => {
    expect(planFileDrop(["/inbox/report.docx", "/inbox/report.docx"], null)).toEqual({
      kind: "import", paths: ["/inbox/report.docx"],
    });
    const target = { id: 42, name: "draft.docx" };
    expect(planFileDrop(["/inbox/report.docx", "/inbox/report.docx"], target)).toEqual({
      kind: "update", sourcePath: "/inbox/report.docx", target,
    });
  });

  it.each([null, { id: 42, name: "draft.docx" }])("rejects a drag without local paths", target => {
    expect(planFileDrop([], target)).toEqual({
      kind: "reject", message: "无法读取本地文件路径，请使用“选择文件”导入。",
    });
  });
});
