import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_RICH_TEXT_STYLE_SETTINGS } from "../../lib/richTextStyle";
import {
  createRecordExportCoordinator,
  type RecordExportPlatform,
  type RecordExportSource,
} from "./recordExport";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Record Export use case", () => {
  it("exports saved Committed Content as portable GFM without private editor data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const targetPath = join(directory, "阶段总结.md");
    const saveCommittedContent = vi.fn(async () => representativeSource);
    const progress: string[] = [];
    const coordinator = createRecordExportCoordinator(
      createFilesystemPlatform(saveCommittedContent),
    );

    const result = await coordinator.export({
      format: "markdown",
      includeImages: false,
      targetPath,
      onProgress: (event) => progress.push(event.stage),
    });

    expect(result).toMatchObject({
      kind: "success",
      path: targetPath,
      warnings: [],
      fontSubstituted: false,
    });
    expect(saveCommittedContent).toHaveBeenCalledOnce();
    expect(progress).toEqual(["preparing", "generating", "writing", "completed"]);

    const markdown = await readFile(targetPath, "utf8");
    expect(markdown).toBe(`---
title: "阶段总结"
project: "阿尔法计划"
tags:
  - "架构"
  - "复盘"
updated: "2026-08-19T15:20:30+08:00"
---

# 阶段总结

# 阶段总结

这是**已确认**的*正文*，还有~~删除~~和\`inline()\`。

## 清单

### 细节

- 普通项

- [x] 已完成
- [ ] 未完成

1. 第一步
2. 第二步

> 可靠引用

| 项目 | 结论 |
| --- | --- |
| A | 保留 |

\`\`\`ts
const answer = 42;
\`\`\`

[公开来源](https://example.com/path) 危险链接 目标记录 @小陈 #架构

[附件：计划.xlsx]
`);
    expect(markdown).not.toContain("javascript:");
    expect(markdown).not.toContain("data-ref-id");
    expect(markdown).not.toContain("/Users/xuchen");
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown).not.toContain("\r");
  });

  it("packages images by final visual content with stable portable names", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const targetPath = join(directory, "带图记录.zip");
    const source: RecordExportSource = {
      ...representativeSource,
      title: "带图记录",
      committedHtml: [
        '<p>前文</p><img data-path="/private/original-a.png" data-mime-type="image/png" alt="架构图" width="640" />',
        '<img data-path="/private/original-a.png" data-mime-type="image/png" alt="架构图窄版" width="320" />',
        '<img data-path="/private/original-a.png" data-mime-type="image/png" alt="有批注" data-annotation-state="{&quot;version&quot;:1,&quot;items&quot;:[{&quot;type&quot;:&quot;rect&quot;}]}" />',
      ].join(""),
    };
    const platform = createFilesystemPlatform(async () => source);
    platform.resolveImage = vi.fn(async (image: { annotationState?: string }) => ({
      kind: "resolved" as const,
      bytes: image.annotationState ? annotatedPng : cleanPng,
      extension: "png",
      mimeType: "image/png",
    }));
    const coordinator = createRecordExportCoordinator(platform);

    const result = await coordinator.export({
      format: "markdown",
      includeImages: true,
      targetPath,
    });

    expect(result.kind).toBe("success");
    const archive = unzipSync(new Uint8Array(await readFile(targetPath)));
    expect(Object.keys(archive).sort()).toEqual([
      "images/image-001.png",
      "images/image-002.png",
      "带图记录.md",
    ]);
    const markdown = new TextDecoder().decode(archive["带图记录.md"]);
    expect(markdown).toContain("![架构图](images/image-001.png)");
    expect(markdown).toContain("![架构图窄版](images/image-001.png)");
    expect(markdown).toContain("![有批注](images/image-002.png)");
    expect(markdown).not.toContain("/private/");
    expect(platform.resolveImage).toHaveBeenCalledTimes(3);
  });

  it("pauses before writing when images are missing and continues only with explicit placeholders", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const targetPath = join(directory, "缺图记录.zip");
    const source: RecordExportSource = {
      ...representativeSource,
      title: "缺图记录",
      committedHtml: '<p>正文</p><img data-path="/missing/photo.jpg" alt="现场照片" />',
    };
    const platform = createFilesystemPlatform(async () => source);
    platform.resolveImage = vi.fn(async () => ({
      kind: "missing" as const,
      label: "现场照片",
      reason: "文件不存在",
    }));
    const coordinator = createRecordExportCoordinator(platform);

    const paused = await coordinator.export({
      format: "markdown",
      includeImages: true,
      targetPath,
    });

    expect(paused).toEqual({
      kind: "missing-images",
      missing: [{ label: "现场照片", reason: "文件不存在" }],
    });
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });

    const completed = await coordinator.export({
      format: "markdown",
      includeImages: true,
      missingImageBehavior: "placeholder",
      targetPath,
    });
    expect(completed.kind).toBe("success");
    const archive = unzipSync(new Uint8Array(await readFile(targetPath)));
    const markdown = new TextDecoder().decode(archive["缺图记录.md"]);
    expect(markdown).toContain("[图片未导出：现场照片]");
    expect(completed).toMatchObject({ warnings: ["1 张图片未能导出"] });
  });

  it("exports an editable DOCX with real headings, lists, tables, links, and embedded images", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const targetPath = join(directory, "阶段总结.docx");
    const source: RecordExportSource = {
      ...representativeSource,
      committedHtml: `${representativeSource.committedHtml}<img src="data:image/png;base64,fixture" alt="架构图" width="400" />`,
    };
    const platform = createFilesystemPlatform(async () => source);
    platform.resolveImage = vi.fn(async () => ({
      kind: "resolved" as const,
      bytes: validPng,
      extension: "png",
      mimeType: "image/png",
    }));

    const result = await createRecordExportCoordinator(platform).export({
      format: "docx",
      targetPath,
    });

    expect(result.kind).toBe("success");
    const archive = unzipSync(new Uint8Array(await readFile(targetPath)));
    expect(Object.keys(archive)).toEqual(expect.arrayContaining([
      "[Content_Types].xml",
      "word/document.xml",
      "word/styles.xml",
      "word/numbering.xml",
      "word/_rels/document.xml.rels",
    ]));
    expect(Object.keys(archive).some((name) => name.startsWith("word/media/"))).toBe(true);
    const documentXml = new TextDecoder().decode(archive["word/document.xml"]);
    expect(documentXml).toContain('w:val="Title"');
    expect(documentXml).toContain('w:val="Heading1"');
    expect(documentXml).toContain("阶段总结");
    expect(documentXml).toContain("已确认");
    expect(documentXml).toContain("w:numPr");
    expect(documentXml).toContain("w:tbl");
    expect(documentXml).toContain("wp:docPr");
    expect(documentXml).toContain('descr="架构图"');
    expect(documentXml).not.toContain("javascript:");
    expect(documentXml).not.toContain("/Users/xuchen");
    const relationships = new TextDecoder().decode(archive["word/_rels/document.xml.rels"]);
    expect(relationships).toContain('Target="https://example.com/path"');
    expect(relationships).not.toContain("javascript:");
  });

  it("exports an A4 tagged PDF with searchable text, safe links, images, embedded font, and page numbers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const targetPath = join(directory, "阶段总结.pdf");
    const source: RecordExportSource = {
      ...representativeSource,
      committedHtml: `${representativeSource.committedHtml}<img src="data:image/png;base64,fixture" alt="架构图" width="400" />`,
    };
    const platform = createFilesystemPlatform(async () => source);
    platform.resolveImage = vi.fn(async () => ({
      kind: "resolved" as const,
      bytes: validPng,
      extension: "png",
      mimeType: "image/png",
      widthPx: 1,
      heightPx: 1,
    }));

    const result = await createRecordExportCoordinator(platform).export({
      format: "pdf",
      targetPath,
    });

    expect(result).toMatchObject({ kind: "success", fontSubstituted: false });
    const bytes = new Uint8Array(await readFile(targetPath));
    expect(new TextDecoder("latin1").decode(bytes)).toContain("/FontFile3");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
    expect(pdf.numPages).toBeGreaterThanOrEqual(1);
    const page = await pdf.getPage(1);
    expect(page.view[2]).toBeCloseTo(595.28, 0);
    expect(page.view[3]).toBeCloseTo(841.89, 0);
    const text = (await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
      const content = await (await pdf.getPage(index + 1)).getTextContent();
      return content.items.map((item) => "str" in item ? item.str : "").join(" ");
    }))).join(" ");
    expect(text).toContain("阶段总结");
    expect(text).toContain("已确认");
    expect(text).toContain("图片：架构图");
    expect(text).toContain("[x] 已完成");
    expect(text).toContain("1 / ");
    const annotations = await page.getAnnotations();
    expect(annotations.some((annotation) => annotation.url === "https://example.com/path")).toBe(true);
    expect(annotations.some((annotation) => annotation.url?.startsWith("javascript:"))).toBe(false);
    expect(await page.getStructTree()).not.toBeNull();
    const operators = (await Promise.all(
      Array.from({ length: pdf.numPages }, async (_, index) => (await (await pdf.getPage(index + 1)).getOperatorList()).fnArray),
    )).flat();
    expect(operators.some((operator) => [
      pdfjs.OPS.paintImageXObject,
      pdfjs.OPS.paintInlineImageXObject,
      pdfjs.OPS.paintImageMaskXObject,
    ].includes(operator))).toBe(true);
    const metadata = await pdf.getMetadata();
    expect(metadata.info).toMatchObject({ Title: "阶段总结", Creator: "Project Mind" });
    await pdf.cleanup();
  });

  it("never writes when save fails, cancellation wins, or disk space is insufficient", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);

    const saveFailureTarget = join(directory, "save-failure.md");
    const saveFailurePlatform = createFilesystemPlatform(async () => {
      throw new Error("数据库暂时不可写");
    });
    const saveFailureWrite = vi.spyOn(saveFailurePlatform, "writeAtomically");
    await expect(createRecordExportCoordinator(saveFailurePlatform).export({
      format: "markdown",
      targetPath: saveFailureTarget,
    })).rejects.toThrow("数据库暂时不可写");
    expect(saveFailureWrite).not.toHaveBeenCalled();
    await expect(readFile(saveFailureTarget)).rejects.toMatchObject({ code: "ENOENT" });

    const imageSource: RecordExportSource = {
      ...representativeSource,
      committedHtml: '<p>正文</p><img src="data:image/png;base64,fixture" alt="大图" />',
    };
    const cancelledTarget = join(directory, "cancelled.docx");
    const cancelledPlatform = createFilesystemPlatform(async () => imageSource);
    cancelledPlatform.resolveImage = vi.fn(async () => ({ kind: "resolved", bytes: validPng, extension: "png", mimeType: "image/png" }));
    const cancelledWrite = vi.spyOn(cancelledPlatform, "writeAtomically");
    const controller = new AbortController();
    await expect(createRecordExportCoordinator(cancelledPlatform).export({
      format: "docx",
      targetPath: cancelledTarget,
      signal: controller.signal,
      onProgress: ({ stage }) => { if (stage === "images") controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelledWrite).not.toHaveBeenCalled();
    await expect(readFile(cancelledTarget)).rejects.toMatchObject({ code: "ENOENT" });

    const diskTarget = join(directory, "disk.md");
    const diskPlatform = createFilesystemPlatform(async () => representativeSource);
    diskPlatform.availableBytes = vi.fn(async () => 0);
    const diskWrite = vi.spyOn(diskPlatform, "writeAtomically");
    await expect(createRecordExportCoordinator(diskPlatform).export({ format: "markdown", targetPath: diskTarget }))
      .rejects.toThrow("磁盘空间不足");
    expect(diskWrite).not.toHaveBeenCalled();
  });

  it("rejects a Record with no title, body, project, or tags", async () => {
    const platform = createFilesystemPlatform(async () => ({
      recordKind: "workspace",
      title: "",
      projectName: null,
      tags: [],
      updatedAt: null,
      committedHtml: "<p></p>",
      style: DEFAULT_RICH_TEXT_STYLE_SETTINGS,
    }));
    await expect(createRecordExportCoordinator(platform).export({ format: "markdown", targetPath: "/tmp/empty.md" }))
      .rejects.toThrow("没有可导出的内容");
  });
});

const representativeSource: RecordExportSource = {
  recordKind: "project",
  title: "阶段总结",
  projectName: "阿尔法计划",
  tags: ["架构", "复盘"],
  updatedAt: "2026-08-19T15:20:30+08:00",
  committedHtml: [
    "<h1>阶段总结</h1>",
    "<p>这是<strong>已确认</strong>的<em>正文</em>，还有<s>删除</s>和<code>inline()</code>。</p>",
    "<h2>清单</h2>",
    "<h3>细节</h3>",
    "<ul><li><p>普通项</p></li></ul>",
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>已完成</p></li><li data-type="taskItem" data-checked="false"><p>未完成</p></li></ul>',
    "<ol><li><p>第一步</p></li><li><p>第二步</p></li></ol>",
    "<blockquote><p>可靠引用</p></blockquote>",
    "<table><tbody><tr><th><p>项目</p></th><th><p>结论</p></th></tr><tr><td><p>A</p></td><td><p>保留</p></td></tr></tbody></table>",
    '<pre><code class="language-ts">const answer = 42;</code></pre>',
    '<p><a href="https://example.com/path">公开来源</a> <a href="javascript:alert(1)">危险链接</a> <span data-type="internal-reference" data-ref-id="88" data-label="目标记录">私有引用</span> <span data-type="contact-mention" data-contact-id="9" data-label="小陈">私有联系人</span> <span data-type="tag-mention" data-tag-id="4" data-label="架构">私有标签</span></p>',
    '<div data-type="attachment" data-title="计划.xlsx" data-path="/Users/xuchen/private/计划.xlsx"><a>本机附件</a></div>',
  ].join(""),
  style: DEFAULT_RICH_TEXT_STYLE_SETTINGS,
};

function createFilesystemPlatform(
  saveCommittedContent: RecordExportPlatform["saveCommittedContent"],
): RecordExportPlatform {
  return {
    saveCommittedContent,
    resolveImage: async () => {
      throw new Error("fixture does not contain images");
    },
    availableBytes: async () => Number.MAX_SAFE_INTEGER,
    loadPdfFont: async () => new Uint8Array(await readFile(join(process.cwd(), "src/assets/fonts/NotoSansCJKsc-Regular.otf"))),
    writeAtomically: async ({ bytes, targetPath }) => {
      const temporaryPath = `${targetPath}.partial`;
      await writeFile(temporaryPath, bytes);
      await rename(temporaryPath, targetPath);
      return targetPath;
    },
  };
}

const cleanPng = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const annotatedPng = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 5, 6, 7, 8]);
const validPng = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
);
