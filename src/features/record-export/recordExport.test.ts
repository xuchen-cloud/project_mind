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
// 中文注释
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
        '<p>前文<img data-path="/private/original-a.png" data-mime-type="image/png" alt="架构图" width="640" /></p>',
        '<p><img data-path="/private/original-a.png" data-mime-type="image/png" alt="架构图窄版" width="320" />',
        '<img data-path="/private/original-a.png" data-mime-type="image/png" alt="有批注" data-annotation-state="{&quot;version&quot;:1,&quot;items&quot;:[{&quot;type&quot;:&quot;rect&quot;}]}" /></p>',
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
      committedHtml: '<p>正文<img data-path="/missing/photo.jpg" alt="现场照片" /></p>',
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
      committedHtml: [
        representativeSource.committedHtml,
        "<ul><li><p>嵌套项</p><blockquote><p>嵌套引用</p></blockquote></li></ul>",
        '<table><tbody><tr><th><p>视觉</p></th></tr><tr><td><p>单元格图片</p><img src="data:image/png;base64,fixture" alt="表格图片" width="120" /></td></tr></tbody></table>',
        '<p><img src="data:image/png;base64,fixture" alt="架构图" width="400" /></p>',
      ].join(""),
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
      committedHtml: [
        representativeSource.committedHtml,
        "<ul><li><p>嵌套项</p><blockquote><p>嵌套引用</p></blockquote></li></ul>",
        '<table><tbody><tr><th><p>视觉</p></th></tr><tr><td><p>单元格图片</p><img src="data:image/png;base64,fixture" alt="表格图片" width="120" /></td></tr></tbody></table>',
        '<p><img src="data:image/png;base64,fixture" alt="架构图" width="400" /></p>',
      ].join(""),
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
    expect(new TextDecoder("latin1").decode(bytes)).toContain("NotoSansMonoCJKsc-Regular");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdf = await pdfjs.getDocument({
      data: bytes,
      disableWorker: true,
      standardFontDataUrl: `${join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts")}/`,
    }).promise;
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
    expect(text).toContain("中文注释");
    expect(text).toContain("图片：架构图");
    expect(text).toMatch(/\[x\]\s+已完成/u);
    expect(text).toContain("1 / ");
    const annotations = (await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => (
      await (await pdf.getPage(index + 1)).getAnnotations()
    )))).flat();
    expect(annotations.map((annotation) => annotation.url).filter(Boolean)).toContain("https://example.com/path");
    expect(annotations.some((annotation) => annotation.url?.startsWith("javascript:"))).toBe(false);
    const structureTrees = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => (
      await (await pdf.getPage(index + 1)).getStructTree()
    )));
    expect(structureTrees.some((tree) => tree && findStructureNode(tree, "Figure", "架构图"))).toBe(true);
    expect(structureTrees.some((tree) => tree && findStructurePath(tree, ["L", "LI", "LBody", "BlockQuote"]))).toBe(true);
    expect(structureTrees.some((tree) => tree && findStructurePath(tree, ["Table", "TR", "TD", "Figure"]))).toBe(true);
    expect(structureTrees.some((tree) => tree && findStructureNode(tree, "H3"))).toBe(true);
    const operators = (await Promise.all(
      Array.from({ length: pdf.numPages }, async (_, index) => (await (await pdf.getPage(index + 1)).getOperatorList()).fnArray),
    )).flat();
    expect(operators.some((operator) => [
      pdfjs.OPS.paintImageXObject,
      pdfjs.OPS.paintInlineImageXObject,
      pdfjs.OPS.paintImageMaskXObject,
    ].includes(operator))).toBe(true);
    const metadata = await pdf.getMetadata();
    expect(metadata.info).toMatchObject({ Title: "阶段总结", Creator: "ProjectMind" });
    const { createCanvas } = await import("@napi-rs/canvas");
    const viewport = page.getViewport({ scale: 0.6 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonWhitePixels = 0;
    let darkPixels = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset] < 248 || pixels[offset + 1] < 248 || pixels[offset + 2] < 248) nonWhitePixels += 1;
      if (pixels[offset] < 180 && pixels[offset + 1] < 180 && pixels[offset + 2] < 180) darkPixels += 1;
    }
    expect(nonWhitePixels).toBeGreaterThan(canvas.width * canvas.height * 0.015);
    expect(darkPixels).toBeGreaterThan(canvas.width * canvas.height * 0.001);
    expect(imageTileSignature(pixels, canvas.width, canvas.height)).toMatchInlineSnapshot(`
      [
        [
          0.052,
          0.064,
          0.029,
          0.025,
          0.001,
          0,
        ],
        [
          0.122,
          0.129,
          0.11,
          0.03,
          0.001,
          0,
        ],
        [
          0.076,
          0.033,
          0,
          0,
          0,
          0,
        ],
        [
          0.115,
          0.166,
          0.141,
          0.141,
          0.141,
          0.061,
        ],
        [
          0.269,
          0.587,
          0.593,
          0.605,
          0.587,
          0.26,
        ],
        [
          0.153,
          0.366,
          0.251,
          0.206,
          0.206,
          0.086,
        ],
        [
          0.135,
          0.385,
          0.381,
          0.381,
          0.381,
          0.196,
        ],
        [
          0,
          0,
          0.004,
          0.004,
          0,
          0,
        ],
      ]
    `);
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
    const diskPlatform = createFilesystemPlatform(async () => imageSource);
    const diskResolve = vi.spyOn(diskPlatform, "resolveImage");
    diskPlatform.availableBytes = vi.fn(async () => 0);
    const diskWrite = vi.spyOn(diskPlatform, "writeAtomically");
    await expect(createRecordExportCoordinator(diskPlatform).export({ format: "markdown", targetPath: diskTarget }))
      .rejects.toThrow("磁盘空间不足");
    expect(diskWrite).not.toHaveBeenCalled();
    expect(diskResolve).not.toHaveBeenCalled();
  });

  it("cancels each format during generation and never commits a partial target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const tableRows = Array.from({ length: 600 }, (_, index) => `<tr><td><p>行 ${index}</p></td><td><p>用于证明生成已经开始</p></td></tr>`).join("");
    const source: RecordExportSource = {
      ...representativeSource,
      committedHtml: `${representativeSource.committedHtml}<table><tbody>${tableRows}</tbody></table><p><img src="data:image/png;base64,fixture" alt="大图" /></p>`,
    };
    for (const format of ["markdown", "docx", "pdf"] as const) {
      const controller = new AbortController();
      const targetPath = join(directory, `cancel-generation.${format === "markdown" ? "zip" : format}`);
      const platform = createFilesystemPlatform(async () => source);
      platform.resolveImage = vi.fn(async () => ({ kind: "resolved", bytes: validPng, extension: "png", mimeType: "image/png" }));
      const write = vi.spyOn(platform, "writeAtomically");

      await expect(createRecordExportCoordinator(platform).export({
        format,
        includeImages: true,
        targetPath,
        signal: controller.signal,
        onProgress: ({ stage }) => { if (stage === "generating") setTimeout(() => controller.abort(), 0); },
      })).rejects.toMatchObject({ name: "AbortError" });

      expect(write).not.toHaveBeenCalled();
      await expect(readFile(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("terminates DOCX and PDF generation workers when cancellation arrives after work starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const terminate = vi.fn();
    let activeController: AbortController | null = null;
    const postMessage = vi.fn(() => setTimeout(() => activeController?.abort(), 0));
    class PendingExportWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      postMessage = postMessage;
      terminate = terminate;
    }
    vi.stubGlobal("Worker", PendingExportWorker);
    try {
      for (const format of ["docx", "pdf"] as const) {
        const controller = new AbortController();
        activeController = controller;
        const targetPath = join(directory, `worker-cancel.${format}`);
        const platform = createFilesystemPlatform(async () => representativeSource);
        const write = vi.spyOn(platform, "writeAtomically");
        await expect(createRecordExportCoordinator(platform).export({
          format,
          targetPath,
          signal: controller.signal,
        })).rejects.toMatchObject({ name: "AbortError" });
        expect(write).not.toHaveBeenCalled();
      }
      expect(postMessage).toHaveBeenCalledTimes(2);
      expect(terminate).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rechecks actual processed image bytes before allocating the document generator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const targetPath = join(directory, "large.docx");
    const platform = createFilesystemPlatform(async () => ({
      ...representativeSource,
      committedHtml: '<p><img src="data:image/png;base64,fixture" alt="高分辨率图片" /></p>',
    }));
    platform.resolveImage = vi.fn(async () => ({
      kind: "resolved" as const,
      bytes: new Uint8Array(2_000_000),
      extension: "png",
      mimeType: "image/png",
      widthPx: 6000,
      heightPx: 4000,
    }));
    platform.availableBytes = vi.fn()
      .mockResolvedValueOnce(Number.MAX_SAFE_INTEGER)
      .mockResolvedValueOnce(2_000_000);
    const write = vi.spyOn(platform, "writeAtomically");

    await expect(createRecordExportCoordinator(platform).export({ format: "docx", targetPath }))
      .rejects.toThrow("磁盘空间不足");
    expect(platform.resolveImage).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
  });

  it("accounts for both bundled PDF fonts before starting document generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const targetPath = join(directory, "font-space.pdf");
    const platform = createFilesystemPlatform(async () => representativeSource);
    platform.availableBytes = vi.fn()
      .mockResolvedValueOnce(50 * 1024 * 1024)
      .mockResolvedValueOnce(50 * 1024 * 1024);
    const loadFonts = vi.spyOn(platform, "loadPdfFonts");
    const write = vi.spyOn(platform, "writeAtomically");

    await expect(createRecordExportCoordinator(platform).export({ format: "pdf", targetPath }))
      .rejects.toThrow("磁盘空间不足");
    expect(loadFonts).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("exports many high-resolution image references without an arbitrary image-count limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "project-mind-record-export-"));
    tempDirectories.push(directory);
    const targetPath = join(directory, "图片集.zip");
    const source: RecordExportSource = {
      ...representativeSource,
      committedHtml: Array.from({ length: 64 }, (_, index) => (
        `<p>图 ${index + 1}<img data-path="/private/image-${index + 1}.png" alt="图片 ${index + 1}" width="4096" /></p>`
      )).join(""),
    };
    const platform = createFilesystemPlatform(async () => source);
    platform.resolveImage = vi.fn(async () => ({
      kind: "resolved" as const,
      bytes: validPng,
      extension: "png",
      mimeType: "image/png",
      widthPx: 4096,
      heightPx: 2160,
    }));

    await expect(createRecordExportCoordinator(platform).export({
      format: "markdown",
      includeImages: true,
      targetPath,
    })).resolves.toMatchObject({ kind: "success" });

    expect(platform.resolveImage).toHaveBeenCalledTimes(64);
    const archive = unzipSync(new Uint8Array(await readFile(targetPath)));
    expect(Object.keys(archive).filter((name) => name.startsWith("images/"))).toHaveLength(1);
    const markdown = new TextDecoder().decode(archive["图片集.md"]);
    expect(markdown).toContain("![图片 64](images/image-001.png)");
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
    '<pre><code class="language-ts">const answer = 42;\n// 中文注释</code></pre>',
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
    loadPdfFonts: async () => ({
      sans: new Uint8Array(await readFile(join(process.cwd(), "src/assets/fonts/NotoSansCJKsc-Regular.otf"))),
      mono: new Uint8Array(await readFile(join(process.cwd(), "src/assets/fonts/NotoSansMonoCJKsc-Regular.otf"))),
    }),
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

function imageTileSignature(pixels: Uint8ClampedArray, width: number, height: number) {
  const columns = 6;
  const rows = 8;
  return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    const startX = Math.floor(column * width / columns);
    const endX = Math.floor((column + 1) * width / columns);
    const startY = Math.floor(row * height / rows);
    const endY = Math.floor((row + 1) * height / rows);
    let ink = 0;
    let total = 0;
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = (y * width + x) * 4;
        if (pixels[offset] < 245 || pixels[offset + 1] < 245 || pixels[offset + 2] < 245) ink += 1;
        total += 1;
      }
    }
    return Math.round((ink / Math.max(1, total)) * 1000) / 1000;
  }));
}

type PdfStructureNode = {
  role?: string;
  alt?: string;
  children?: PdfStructureNode[];
};

function findStructureNode(node: PdfStructureNode, role: string, alt?: string): boolean {
  if (node.role === role && (alt === undefined || node.alt === alt)) return true;
  return node.children?.some((child) => findStructureNode(child, role, alt)) ?? false;
}

function findStructurePath(node: PdfStructureNode, roles: string[]): boolean {
  if (roles.length === 0) return true;
  if (node.role === roles[0]) {
    if (roles.length === 1) return true;
    if (node.children?.some((child) => findStructurePath(child, roles.slice(1)))) return true;
  }
  return node.children?.some((child) => findStructurePath(child, roles)) ?? false;
}
