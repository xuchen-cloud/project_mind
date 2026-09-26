import { describe, expect, it } from "vitest";

import { deriveQuickNoteMetadata } from "./quick-note-metadata";

describe("deriveQuickNoteMetadata", () => {
  it("keeps a heading as the suggested title and ignores code when finding explicit Tags", () => {
    const result = deriveQuickNoteMetadata(`# 协作节奏

每周一确认项目进展。 #工作方法

\`#inlineCode\`

\`\`\`ts
const example = "#codeTag";
\`\`\``);

    expect(result).toEqual({ title: "协作节奏", tagLabels: ["工作方法"] });
  });

  it("does not turn a long opening paragraph into a Record title", () => {
    const result = deriveQuickNoteMetadata("今天讨论了如何把跨项目的资料放到有上下文的位置，并约定下一次评审时再检查结果。\n\n#协作");
    expect(result).toEqual({ title: undefined, tagLabels: ["协作"] });
  });
});
