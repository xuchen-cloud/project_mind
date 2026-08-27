import { describe, expect, it } from "vitest";

import type { ProjectTagRecord } from "./types";
import { buildRecordAiMetadataJobInput } from "./recordAiMetadata";

const availableTags: ProjectTagRecord[] = [
  {
    id: 11,
    label: "产品",
    colorKey: "blue",
    usageCount: 3,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: 12,
    label: "用户研究",
    colorKey: "teal",
    usageCount: 1,
    createdAt: "",
    updatedAt: "",
  },
];

describe("Record AI metadata", () => {
  it("builds a dedicated metadata job with Committed Content and every scoped Tag", () => {
    const job = buildRecordAiMetadataJobInput({
      targetKey: "record-ai-metadata:project:5:8",
      markdown: "访谈发现用户很难找到导出入口。",
      availableTags,
    });

    expect(job).toEqual({
      kind: "record_metadata",
      targetKey: "record-ai-metadata:project:5:8",
      input: {
        markdown: "访谈发现用户很难找到导出入口。",
        existingTags: [
          { id: 11, label: "产品" },
          { id: 12, label: "用户研究" },
        ],
      },
    });
  });
});
