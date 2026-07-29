import type { TagColorKey, ProjectTagRecord } from "./types";

const HASH_TAG_PATTERN = /(^|\s)[#＃]([^\s#＃]+)/gu;
const HASH_TAG_TRIGGER_TOKENS = ["#", "＃"] as const;
const DEFAULT_TAG_COLOR_KEYS: TagColorKey[] = [
  "blue",
  "teal",
  "green",
  "amber",
  "orange",
  "rose",
  "slate",
  "red",
];

export function extractHashTagLabels(value: string) {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const match of value.matchAll(HASH_TAG_PATTERN)) {
    const label = match[2]?.trim().replace(/[，。；;,.!?！？、]+$/u, "") ?? "";
    if (!label) continue;
    const key = label.toLocaleLowerCase("zh-Hans-CN");
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }

  return labels;
}

export function stripHashTagText(value: string) {
  if (!value) {
    return value;
  }

  return value
    .replace(HASH_TAG_PATTERN, (_match, leadingWhitespace: string) => leadingWhitespace || "")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

export interface HashTagTextTrigger {
  start: number;
  end: number;
  query: string;
}

export function findHashTagTextTrigger(
  source: string,
  caretPosition: number | null | undefined,
): HashTagTextTrigger | null {
  if (
    typeof caretPosition !== "number" ||
    caretPosition < 0 ||
    caretPosition > source.length
  ) {
    return null;
  }

  const beforeCaret = source.slice(0, caretPosition);
  let start = -1;
  let triggerToken: (typeof HASH_TAG_TRIGGER_TOKENS)[number] | null = null;

  for (const token of HASH_TAG_TRIGGER_TOKENS) {
    const candidateStart = beforeCaret.lastIndexOf(token);

    if (candidateStart > start) {
      start = candidateStart;
      triggerToken = token;
    }
  }

  if (start < 0 || !triggerToken) {
    return null;
  }

  if (start > 0) {
    const charBefore = beforeCaret[start - 1];
    if (!/\s/u.test(charBefore)) {
      return null;
    }
  }

  const query = beforeCaret.slice(start + triggerToken.length);

  if (/[\s\r\n#＃\]]/u.test(query)) {
    return null;
  }

  return { start, end: caretPosition, query };
}

export function mergeUniqueTagIds(...groups: Array<Array<number | undefined | null>>) {
  const ids: number[] = [];
  const seen = new Set<number>();

  for (const group of groups) {
    for (const id of group) {
      if (typeof id !== "number" || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

export function colorKeyForTagLabel(label: string): TagColorKey {
  let hash = 0;
  for (const char of label) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return DEFAULT_TAG_COLOR_KEYS[hash % DEFAULT_TAG_COLOR_KEYS.length];
}

export function findTagByLabel(tags: ProjectTagRecord[], label: string) {
  const normalized = label.trim().toLocaleLowerCase("zh-Hans-CN");
  return tags.find((tag) => tag.label.toLocaleLowerCase("zh-Hans-CN") === normalized) ?? null;
}
