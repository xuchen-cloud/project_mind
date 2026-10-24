import { describe, expect, it } from "vitest";

import { buildInternalReferenceTarget, buildInternalReferenceToken, splitInternalReferenceText, buildInternalReferenceHtml, readInternalReferenceElement, validateInternalReferenceSourceRef, resolveFixedFileLocator } from "./internalReferences";

describe("internalReferences", () => {
  it("keeps Workspace Record tokens distinct from colliding Project Record IDs", () => {
    const references = splitInternalReferenceText("[[note:42|项目资料]] 和 [[workspace_record:42|个人方法]]")
      .filter((segment) => segment.type === "reference")
      .map((segment) => segment.reference);
    expect(references).toEqual([
      { refKind: "note", refId: 42, label: "项目资料" },
      { refKind: "workspace_record", refId: 42, label: "个人方法" },
    ]);
    const workspace = buildInternalReferenceTarget({kind:"workspace_record",id:42,label:"个人方法"});
    expect(buildInternalReferenceToken(workspace)).toBe("[[workspace_record:42|个人方法]]");
    const container = document.createElement("div");
    container.innerHTML = buildInternalReferenceHtml(workspace);
    expect(readInternalReferenceElement(container.firstElementChild as HTMLElement)).toEqual(workspace);
  });
  it("strips nested internal reference labels and truncates Todo chips", () => {
    expect(
      buildInternalReferenceToken({
        refKind: "todo",
        refId: 18,
        label: "[[document:2|预算材料.pdf]] 联系财务安排评审并确认后续计划时间",
      }),
    ).toBe("[[todo:18|联系财务安排评审并确认后续计划...]]");
  });

  it("keeps note labels readable without applying the compact Todo limit", () => {
    expect(
      buildInternalReferenceTarget({
        kind: "note",
        id: 4,
        label: "[[todo:2|推进预算审批]] 预算审批会议纪要需要补充材料并确认时间安排",
      }).label,
    ).toBe("预算审批会议纪要需要补充材料并确认时间安排");
  });
});

const fixedFileSource = { object: { workspaceId: "w1", scope: { kind: "project" as const, projectId: 7 }, kind: "file" as const, id: "51" },
  revision: `sha256:${"a".repeat(64)}`, fileVersion: 2, recordVersion: null, blockId: null,
  locator: { kind: "page" as const, page: 3, start: 1, end: 2 }, title: '材料 "<>&.pdf', excerpt: "证据 & <quote>" };
it("preserves fixed File evidence through escaped HTML and target normalization", () => {
  const target = { refKind: "document" as const, refId: 51, label: "资料", sourceRef: fixedFileSource };
  const container = document.createElement("div");
  const html = buildInternalReferenceHtml(target);
  expect(html).toContain("data-source-ref=");
  expect(html).toContain("&quot;");
  container.innerHTML = html;
  expect(readInternalReferenceElement(container.firstElementChild as HTMLElement)).toEqual(target);
  expect(buildInternalReferenceTarget(target).sourceRef).toEqual(fixedFileSource);
});
it("does not manufacture a version for old tokens and rejects malformed fixed evidence", () => {
  expect(splitInternalReferenceText("[[document:51|旧文件]]")[0]).toMatchObject({ reference: { refKind: "document", refId: 51 } });
  const container = document.createElement("div");
  container.innerHTML = '<span data-ref-kind="document" data-ref-id="51" data-source-ref="{}"></span>';
  expect(() => readInternalReferenceElement(container.firstElementChild as HTMLElement)).toThrow();
});

describe("fixed File locator coordinates", () => {
  it.each([
    { kind: "line", start: 1, end: 3 },
    { kind: "page", page: 2, start: 0, end: 19 },
  ])("accepts valid $kind coordinates", (locator) => {
    expect(validateInternalReferenceSourceRef({ ...fixedFileSource, locator }).locator).toEqual(locator);
  });
  it.each([
    { kind: "line", start: 0, end: 3 },
    { kind: "paragraph", start: 0, end: 3 },
    { kind: "line", start: 3, end: 2 },
    { kind: "page", page: 0, start: 0, end: 19 },
    { kind: "page", page: 2, start: -1, end: 19 },
    { kind: "page", page: 2, start: 19, end: 0 },
  ])("rejects invalid locator $kind/$start/$end", (locator) => {
    expect(() => validateInternalReferenceSourceRef({ ...fixedFileSource, locator })).toThrow();
  });
  it("maps real lines and pages while preserving offsets and never treating paragraphs as lines", () => {
    for (const [locator, coordinates] of [
      [{ kind: "line", start: 8, end: 10 }, { line: 8 }],
      [{ kind: "page", page: 2, start: 0, end: 19 }, { page: 2 }],
      [{ kind: "paragraph", start: 2, end: 3 }, {}],
    ] as const) {
      const source = validateInternalReferenceSourceRef({ ...fixedFileSource, locator });
      expect(resolveFixedFileLocator(source)).toEqual({ ...coordinates, sourceLocator: locator });
    }
    expect(resolveFixedFileLocator({ ...fixedFileSource, locator: null })).toEqual({});
  });
});

it("round-trips Workspace fixed File chips while retaining their original owner and evidence", () => {
  const source = { ...fixedFileSource, object: { ...fixedFileSource.object, scope: { kind: "workspace" as const } } };
  const reference = { refKind: "document" as const, refId: Number(source.object.id), label: "工作区材料", sourceRef: source };
  const container = document.createElement("div");
  container.innerHTML = buildInternalReferenceHtml(reference);
  expect(readInternalReferenceElement(container.firstElementChild as HTMLElement)).toEqual(reference);
});
