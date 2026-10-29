import { describe, expect, it } from "vitest";

import { deriveContactNicknamePinyin, deriveContactPinyin } from "./pinyin";

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

describe("deriveContactNicknamePinyin", () => {
  it("normalizes semicolon-separated aliases and derives searchable full pinyin and initials", () => {
    expect(deriveContactNicknamePinyin(" 老张； ;老张;重庆; Ada Lovelace ; ")).toBe("laozhang lz chongqing cq adalovelace al");
  });

  it("preserves commas and pipes inside aliases, handles empty aliases and bounds the derived index", () => {
    expect(deriveContactNicknamePinyin(" ;； ")).toBe("");
    expect(deriveContactNicknamePinyin("Ada,Lee|Sales; Ada,Lee|Sales")).toBe("adaleesales a");
    const manyAliases = Array.from({ length: 3000 }, (_, index) => `Alias${index}`).join(";");
    expect(deriveContactNicknamePinyin(manyAliases)).toHaveLength(8192);
  });
});
