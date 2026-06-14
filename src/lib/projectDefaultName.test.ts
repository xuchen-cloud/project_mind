import { describe, expect, it } from "vitest";

import { generateDefaultProjectName } from "./projectDefaultName";

describe("generateDefaultProjectName", () => {
  it("returns the base default name when unused", () => {
    expect(generateDefaultProjectName([])).toBe("未命名项目");
  });

  it("increments the suffix when the base name already exists", () => {
    expect(generateDefaultProjectName(["未命名项目"])).toBe("未命名项目 2");
  });

  it("fills the next available suffix", () => {
    expect(
      generateDefaultProjectName(["Alpha", "未命名项目", "未命名项目 2", "未命名项目 4"]),
    ).toBe("未命名项目 3");
  });
});
