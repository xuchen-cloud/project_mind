import { describe, expect, it } from "vitest";

import { deriveContactPinyin } from "./pinyin";

describe("deriveContactPinyin", () => {
  it("converts a Chinese name to toneless full pinyin and an abbreviation", () => {
    const result = deriveContactPinyin("张三");
    expect(result.pinyinFull).toBe("zhangsan");
    expect(result.pinyinAbbr).toBe("zs");
  });

  it("handles multi-character Chinese names", () => {
    const result = deriveContactPinyin("欧阳锋");
    expect(result.pinyinFull).toBe("ouyangfeng");
    expect(result.pinyinAbbr).toBe("oyf");
  });

  it("degrades gracefully for latin names", () => {
    const result = deriveContactPinyin("Ada Lovelace");
    expect(result.pinyinFull).toBe("adalovelace");
    expect(result.pinyinAbbr).toBe("al");
  });

  it("returns empty values for a blank name", () => {
    expect(deriveContactPinyin("   ")).toEqual({ pinyinFull: "", pinyinAbbr: "" });
  });
});
