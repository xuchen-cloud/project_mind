import type { FileTagColorKey, FileTagRecord } from "./types";

const HASH_TAG_PATTERN = /(^|\s)#([^\s#]+)/gu;
const DEFAULT_TAG_COLOR_KEYS: FileTagColorKey[] = [
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

export function colorKeyForTagLabel(label: string): FileTagColorKey {
  let hash = 0;
  for (const char of label) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return DEFAULT_TAG_COLOR_KEYS[hash % DEFAULT_TAG_COLOR_KEYS.length];
}

export function findTagByLabel(tags: FileTagRecord[], label: string) {
  const normalized = label.trim().toLocaleLowerCase("zh-Hans-CN");
  return tags.find((tag) => tag.label.toLocaleLowerCase("zh-Hans-CN") === normalized) ?? null;
}
