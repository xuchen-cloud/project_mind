import type { JSONContent } from "@tiptap/core";

export function recordBlockDescriptions(document: JSONContent) {
  const result = new Map<string, string>();
  function text(node: JSONContent): string {
    if (node.text !== undefined) return node.text;
    if (node.content?.length) return node.content.map(text).join(" ");
    if (node.type === "image" || node.type === "attachment") return String(node.attrs?.title || node.attrs?.alt || (node.type === "image" ? "图片" : "附件"));
    return String(node.attrs?.label ?? "");
  }
  function visit(node: JSONContent) {
    if (typeof node.attrs?.blockId === "string") result.set(node.attrs.blockId, text(node));
    node.content?.forEach(visit);
  }
  visit(document);
  return result;
}
