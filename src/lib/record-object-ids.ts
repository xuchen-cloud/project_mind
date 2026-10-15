import type { JSONContent } from "@tiptap/core";

/** HTML attributes carry IDs as strings; keep the stored representation while
 * using the same positive, safe integer range at every Record boundary. */
export function positiveRecordObjectId(value: unknown): number | null {
  if (typeof value === "string" && !/^[1-9][0-9]*$/.test(value)) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function recordMentionTagIds(document: JSONContent): number[] {
  const tags = new Set<number>();
  const visit = (node: JSONContent) => {
    const id = node.type === "tagMention" ? positiveRecordObjectId(node.attrs?.tagId) : null;
    if (id !== null) tags.add(id);
    node.content?.forEach(visit);
  };
  visit(document);
  return [...tags].sort((a, b) => a - b);
}
