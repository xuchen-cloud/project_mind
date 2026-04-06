import type { NoteRecord, NoteTemplateKey } from "./types";

const EMPTY_EDITOR_HTML = "<p></p>";
const HTML_TAG_PATTERN = /<[^>]+>/;

export interface NoteTemplateDefinition {
  key: NoteTemplateKey;
  label: string;
  eyebrow: string;
  description: string;
  defaultTitle: string;
  placeholder: string;
  emptyStateText: string;
  defaultHtml: string;
}

export const NOTE_TEMPLATES: Record<NoteTemplateKey, NoteTemplateDefinition> = {
  quick_note: {
    key: "quick_note",
    label: "原始记录",
    eyebrow: "Activity Notes",
    description: "快速捕获未经整理的事实、反馈和上下文。",
    defaultTitle: "记录",
    placeholder: "想到就写。先留下原始信息，再决定是否提炼。",
    emptyStateText: "还没有记录，先新建一条原始记录。",
    defaultHtml: EMPTY_EDITOR_HTML,
  },
  meeting_minutes: {
    key: "meeting_minutes",
    label: "会议记录",
    eyebrow: "Activity Notes",
    description: "用于整理会议过程、结论和后续动作。",
    defaultTitle: "记录",
    placeholder: "整理会议纪要。支持 Markdown 快捷输入和富文本粘贴。",
    emptyStateText: "还没有会议记录。",
    defaultHtml:
      "<h2>背景</h2><p></p><h2>讨论要点</h2><p></p><h2>初步结论</h2><p></p><h2>行动项</h2><p></p>",
  },
};

export const NOTE_TEMPLATE_OPTIONS = Object.values(NOTE_TEMPLATES).map((template) => ({
  value: template.key,
  label: template.label,
}));

export function noteTemplateLabel(templateKey: string) {
  return NOTE_TEMPLATES[normalizeNoteTemplateKey(templateKey)].label;
}

export function noteTemplateDescription(templateKey: string) {
  return NOTE_TEMPLATES[normalizeNoteTemplateKey(templateKey)].description;
}

export function noteTemplateDefaultTitle(templateKey: NoteTemplateKey) {
  return NOTE_TEMPLATES[templateKey].defaultTitle;
}

export function noteTemplatePlaceholder(templateKey: NoteTemplateKey) {
  return NOTE_TEMPLATES[templateKey].placeholder;
}

export function noteTemplateEmptyState(templateKey: NoteTemplateKey) {
  return NOTE_TEMPLATES[templateKey].emptyStateText;
}

export function noteTemplateDefaultHtml(templateKey: NoteTemplateKey) {
  return NOTE_TEMPLATES[templateKey].defaultHtml;
}

export function createDraftNote(templateKey: NoteTemplateKey = "quick_note") {
  return {
    localId: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    noteType: templateKey,
    title: noteTemplateDefaultTitle(templateKey),
    contentMarkdown: "",
    contentHtml: noteTemplateDefaultHtml(templateKey),
  };
}

export function isDefaultNoteTitle(title: string | null | undefined, templateKey: NoteTemplateKey) {
  const normalized = title?.trim();

  if (!normalized) {
    return true;
  }

  return normalized === noteTemplateDefaultTitle(templateKey);
}

export function getRenderableNoteHtml(note: Pick<NoteRecord, "contentHtml" | "contentMarkdown">) {
  const normalizedHtml = note.contentHtml.trim();

  if (!normalizedHtml) {
    return note.contentMarkdown.trim()
      ? plainTextToHtml(note.contentMarkdown)
      : EMPTY_EDITOR_HTML;
  }

  if (HTML_TAG_PATTERN.test(normalizedHtml)) {
    return normalizedHtml;
  }

  return plainTextToHtml(note.contentMarkdown || normalizedHtml);
}

export function summarizeNoteContent(note: Pick<NoteRecord, "contentMarkdown">) {
  const normalized = note.contentMarkdown.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 96) : "尚未填写内容";
}

export function normalizeNoteTemplateKey(templateKey: string | null | undefined): NoteTemplateKey {
  if (templateKey === "meeting_minutes") {
    return "meeting_minutes";
  }

  return "quick_note";
}

export function plainTextToHtml(source: string) {
  const normalized = source.trim();

  if (!normalized) {
    return EMPTY_EDITOR_HTML;
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) =>
      `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`,
    );

  return paragraphs.join("");
}

function escapeHtml(source: string) {
  return source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
