// @vitest-environment node
import { getSchema } from "@tiptap/core";
import { expect, it } from "vitest";
import { buildRichEditorExtensions } from "../components/rich-editor/extensions";
import { parseRecordHtml } from "./record-document-html";
import { serializeRecordDocument } from "./record-document-format";

const schema = getSchema(buildRichEditorExtensions("", { stableBlocks: true, portableAssets: true }));

it("round trips both Record reference scopes through legacy HTML conversion", () => {
  const document=parseRecordHtml('<p><span data-type="internal-reference" data-ref-kind="workspace_record" data-ref-id="42" data-label="个人方法">个人方法</span> 和 <span data-type="internal-reference" data-ref-kind="note" data-ref-id="42" data-label="项目资料">项目资料</span></p>',schema);
  const projection=serializeRecordDocument(document,schema);
  expect(projection.markdown).toBe("[[workspace_record:42|个人方法]] 和 [[note:42|项目资料]]");
  expect(parseRecordHtml(projection.html,schema)).toEqual(document);
});

it("uses the same editor parse rules for a lossless legacy baseline without a browser", () => {
  const html = '<h2>标题 <strong>粗体</strong></h2><ul><li><p>列表</p></li></ul>'
    + '<table><tbody><tr><td colwidth="120"><p>单元格</p></td></tr></tbody></table>'
    + '<pre data-language="typescript" data-language-explicit="true"><code class="language-typescript">const x = 1;\n</code></pre>'
    + '<img src="asset://localhost/old/path.png" data-path="assets/图片.png" data-annotation-state="{&quot;shape&quot;:&quot;rect&quot;}" width="120">'
    + '<div data-type="attachment" data-title="文件" data-path="assets/文件.pdf" data-meta="PDF"></div>';
  const canonical = parseRecordHtml(html, schema);
  const projection = serializeRecordDocument(canonical, schema);
  expect(parseRecordHtml(projection.html, schema)).toEqual(canonical);
  expect(projection.document.content!.at(-2)!.attrs!.annotationState).toBe('{"shape":"rect"}');
  expect(projection.document.content!.at(-2)!.attrs!.path).toBe("assets/图片.png");
  expect(projection.html).not.toContain("/old/path");
});

it("diagnoses unsupported custom nodes and attributes instead of silently deleting them", () => {
  expect(() => parseRecordHtml('<div data-type="privateWidget" data-secret="retain">Body</div>', schema)).toThrow(/Unsupported/);
  expect(() => parseRecordHtml('<p data-private="retain">Body</p>', schema)).toThrow(/Unsupported/);
  expect(() => parseRecordHtml('<p data-path="retain">Body</p>', schema)).toThrow(/Unsupported/);
  expect(() => parseRecordHtml('<p style="text-align: right">Body</p>', schema)).toThrow(/Unsupported/);
  expect(() => parseRecordHtml('<video src="video.mp4"></video>', schema)).toThrow(/Unsupported/);
  expect(() => parseRecordHtml('<p><a href="javascript:alert(1)">Preserve original link</a></p>', schema)).toThrow(/link/i);
  expect(() => parseRecordHtml('<p><span data-type="internal-reference" data-ref-kind="private_kind" data-ref-id="12">Preserve original reference</span></p>', schema)).toThrow(/reference/i);
});

it("migrates Project-relative managed paths using a trusted portable base without rewriting user text", () => {
  const html = '<p>Literal assets/图片.png</p><img data-path="assets/图片.png" src="asset://old-machine/image">';
  const document = parseRecordHtml(html, schema, { assetBasePath: 'projects/项目' });
  expect(document.content![0].content![0].text).toBe('Literal assets/图片.png');
  expect(document.content![1].attrs!.path).toBe('projects/项目/assets/图片.png');
  const projection = serializeRecordDocument(document, schema);
  expect(parseRecordHtml(projection.html, schema)).toEqual(document);
  expect(() => parseRecordHtml(html, schema, { assetBasePath: '../outside' })).toThrow(/base/);
});

it("preserves fixed File SourceRef in canonical projection and legacy HTML conversion", () => {
  const sourceRef = { object: { workspaceId: "w1", scope: { kind: "project", projectId: 7 }, kind: "file", id: "51" },
    revision: `sha256:${"a".repeat(64)}`, fileVersion: 2, recordVersion: null, blockId: null, locator: null,
    title: '材料 "<>&.pdf', excerpt: "证据 & <quote>" };
  const json = JSON.stringify(sourceRef).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  const document = parseRecordHtml(`<p><span data-type="internal-reference" data-ref-kind="document" data-ref-id="51" data-label="材料" data-source-ref="${json}">材料</span></p>`, schema);
  expect(document.content![0].content![0].attrs!.sourceRef).toEqual(sourceRef);
  const projection = serializeRecordDocument(document, schema);
  expect(projection.document.content![0].content![0].attrs!.sourceRef).toEqual(sourceRef);
  expect(projection.document.content![0].content![0].attrs!.refId).toBe(51);
  expect(parseRecordHtml(projection.html, schema)).toEqual(document);
  expect(() => parseRecordHtml(projection.html.replace('data-ref-id="51"', 'data-ref-id="52"'), schema)).toThrow(/identity/);
  expect(() => parseRecordHtml(projection.html.replace('data-ref-kind="document"', 'data-ref-kind="todo"'), schema)).toThrow(/identity/);
});
