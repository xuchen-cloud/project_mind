import { pinyin } from "pinyin-pro";

export interface ContactPinyin {
  pinyinFull: string;
  pinyinAbbr: string;
}

const PINYIN_MAX_CHARS = 128;

/**
 * Derive searchable pinyin from a (possibly Chinese) contact name.
 *
 * - `pinyinFull` is the toneless full pinyin with separators removed, e.g.
 *   "张三" -> "zhangsan".
 * - `pinyinAbbr` keeps the first letter of each syllable, e.g. "张三" -> "zs".
 *
 * ASCII / latin names degrade gracefully: only alphanumeric characters survive
 * in the full form, and the abbreviation keeps the leading letter of each
 * whitespace-separated part. This mirrors the backend fallback so the two stay
 * consistent when the frontend cannot supply pinyin.
 */
export function deriveContactPinyin(name: string): ContactPinyin {
  const trimmed = name.trim();

  if (!trimmed) {
    return { pinyinFull: "", pinyinAbbr: "" };
  }

  const hasChinese = /[一-鿿]/u.test(trimmed);

  if (!hasChinese) {
    const full = trimmed.replace(/[^a-zA-Z0-9]/gu, "").toLowerCase();
    const abbr = trimmed
      .split(/\s+/u)
      .map((part) => part.replace(/[^a-zA-Z0-9]/gu, "").charAt(0))
      .join("")
      .toLowerCase();

    return {
      pinyinFull: full.slice(0, PINYIN_MAX_CHARS),
      pinyinAbbr: abbr.slice(0, PINYIN_MAX_CHARS),
    };
  }

  const full = pinyin(trimmed, { toneType: "none", type: "array", v: true })
    .join("")
    .replace(/[^a-zA-Z0-9]/gu, "")
    .toLowerCase();
  const abbr = pinyin(trimmed, {
    pattern: "first",
    toneType: "none",
    type: "array",
    v: true,
  })
    .join("")
    .replace(/[^a-zA-Z0-9]/gu, "")
    .toLowerCase();

  return {
    pinyinFull: full.slice(0, PINYIN_MAX_CHARS),
    pinyinAbbr: abbr.slice(0, PINYIN_MAX_CHARS),
  };
}
