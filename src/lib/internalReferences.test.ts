import { describe, expect, it } from "vitest";

import { buildInternalReferenceTarget, buildInternalReferenceToken, splitInternalReferenceText, buildInternalReferenceHtml, readInternalReferenceElement } from "./internalReferences";

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
