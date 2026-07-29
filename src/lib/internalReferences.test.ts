import { describe, expect, it } from "vitest";

import {
  buildInternalReferenceTarget,
  buildInternalReferenceToken,
} from "./internalReferences";

describe("internalReferences", () => {
  it("strips nested internal reference labels and truncates todo/conclusion chips", () => {
    expect(
      buildInternalReferenceTarget({
        kind: "conclusion",
        id: 9,
        label: "[[note:1|预算记录]] 预算审批需要补充材料并确认时间安排",
      }).label,
    ).toBe("预算审批需要补充材料并确认时间...");

    expect(
      buildInternalReferenceToken({
        refKind: "todo",
        refId: 18,
        label: "[[document:2|预算材料.pdf]] 联系财务安排评审并确认后续计划时间",
      }),
    ).toBe("[[todo:18|联系财务安排评审并确认后续计划...]]");
  });

  it("keeps note labels readable without applying the compact todo/conclusion limit", () => {
    expect(
      buildInternalReferenceTarget({
        kind: "note",
        id: 4,
        label: "[[todo:2|推进预算审批]] 预算审批会议纪要需要补充材料并确认时间安排",
      }).label,
    ).toBe("预算审批会议纪要需要补充材料并确认时间安排");
  });
});
