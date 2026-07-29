import type { DocumentTagRecord, ProjectTagRecord } from "./types";

export interface TagMentionTarget {
  tagId: number;
  label: string;
  colorKey: string;
}

export function buildTagMentionToken(tag: TagMentionTarget) {
  return `#[tag:${tag.tagId}|${sanitizeTagMentionLabel(tag.label)}|${sanitizeTagMentionColorKey(tag.colorKey)}]`;
}

export function buildTagMentionTarget(
  tag: TagMentionTarget | Pick<ProjectTagRecord, "id" | "label" | "colorKey"> | Pick<DocumentTagRecord, "id" | "label" | "colorKey">,
): TagMentionTarget {
  if ("tagId" in tag) {
    return {
      tagId: sanitizeTagMentionId(tag.tagId),
      label: sanitizeTagMentionLabel(tag.label),
      colorKey: sanitizeTagMentionColorKey(tag.colorKey),
    };
  }

  return {
    tagId: sanitizeTagMentionId(tag.id),
    label: sanitizeTagMentionLabel(tag.label),
    colorKey: sanitizeTagMentionColorKey(tag.colorKey),
  };
}

export function buildTagMentionHtml(tag: TagMentionTarget) {
  const normalized = buildTagMentionTarget(tag);
  return `<span data-type="tag-mention" data-tag-id="${normalized.tagId}" data-label="${escapeHtmlAttribute(normalized.label)}" data-color-key="${escapeHtmlAttribute(normalized.colorKey)}" class="tag-mention-chip" contenteditable="false"><span class="tag-mention-chip__sigil">#</span><span class="tag-mention-chip__label">${escapeHtml(normalized.label)}</span></span>`;
}

export function splitTagMentionText(source: string) {
  const pattern = /#\[tag:(\d+)\|([^|\]]+)\|([^|\]]+)\]/g;
  const segments: Array<
    | { type: "text"; text: string }
    | { type: "tag"; tag: TagMentionTarget }
  > = [];

  let lastIndex = 0;
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(source)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: source.slice(lastIndex, match.index) });
    }

    segments.push({
      type: "tag",
      tag: buildTagMentionTarget({
        tagId: Number(match[1]),
        label: match[2],
        colorKey: match[3],
      }),
    });

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < source.length) {
    segments.push({ type: "text", text: source.slice(lastIndex) });
  }

  return segments;
}

export function extractTagMentionIds(source: string) {
  return splitTagMentionText(source)
    .filter((segment): segment is { type: "tag"; tag: TagMentionTarget } => segment.type === "tag")
    .map((segment) => segment.tag.tagId)
    .filter((tagId, index, values) => tagId > 0 && values.indexOf(tagId) === index);
}

function sanitizeTagMentionId(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function sanitizeTagMentionLabel(label: unknown) {
  return typeof label === "string" && label.trim().length > 0
    ? label.trim().replace(/[|\]]/g, "")
    : "未命名标签";
}

function sanitizeTagMentionColorKey(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().replace(/[|\]]/g, "")
    : "slate";
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeHtmlAttribute(value: string) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}
