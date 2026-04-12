import type {
  FileTagColorKey,
  NoteRecord,
  NoteTemplateKey,
  RecordTypeRecord,
  RecordTypeSettingsSnapshot,
} from "./types";
import {
  EMPTY_RICH_TEXT_HTML,
  getEditableRichTextHtml,
  getRenderableRichTextHtml,
  richTextHtmlToPlainText,
} from "./richTextContent";

const EMPTY_EDITOR_HTML = EMPTY_RICH_TEXT_HTML;
const NOTE_EYEBROW = "Activity Notes";
const NOTE_DEFAULT_TITLE = "记录";
const NOTE_PLACEHOLDER = "想到就写。先留下原始信息，再决定是否提炼。";
const NOTE_EMPTY_STATE_TEXT = "还没有记录。";

export interface NoteTemplateDefinition {
  key: NoteTemplateKey;
  label: string;
  colorKey: FileTagColorKey;
  eyebrow: string;
  description: string;
  defaultTitle: string;
  placeholder: string;
  emptyStateText: string;
  defaultHtml: string;
  isDefault: boolean;
}

export const NOTE_TEMPLATES: Record<string, NoteTemplateDefinition> = {
  quick_note: {
    key: "quick_note",
    label: "原始记录",
    colorKey: "slate",
    eyebrow: NOTE_EYEBROW,
    description: "快速捕获未经整理的事实、反馈和上下文。",
    defaultTitle: NOTE_DEFAULT_TITLE,
    placeholder: NOTE_PLACEHOLDER,
    emptyStateText: "还没有记录，先新建一条原始记录。",
    defaultHtml: EMPTY_EDITOR_HTML,
    isDefault: true,
  },
  meeting_minutes: {
    key: "meeting_minutes",
    label: "会议记录",
    colorKey: "blue",
    eyebrow: NOTE_EYEBROW,
    description: "用于整理会议过程、结论和后续动作。",
    defaultTitle: NOTE_DEFAULT_TITLE,
    placeholder: NOTE_PLACEHOLDER,
    emptyStateText: "还没有会议记录。",
    defaultHtml:
      "<h2>背景</h2><p></p><h2>讨论要点</h2><p></p><h2>初步结论</h2><p></p><h2>行动项</h2><p></p>",
    isDefault: false,
  },
};

export function resolveNoteTemplateDefinitions(
  snapshot?: RecordTypeSettingsSnapshot | null,
): NoteTemplateDefinition[] {
  if (snapshot?.recordTypes.length) {
    return snapshot.recordTypes.map(buildDefinitionFromRecord);
  }

  return Object.values(NOTE_TEMPLATES);
}

export function noteTemplateOptions(snapshot?: RecordTypeSettingsSnapshot | null) {
  return resolveNoteTemplateDefinitions(snapshot).map((template) => ({
    value: template.key,
    label: template.label,
    colorKey: template.colorKey,
  }));
}

export function defaultNoteTemplateKey(snapshot?: RecordTypeSettingsSnapshot | null) {
  return (
    resolveNoteTemplateDefinitions(snapshot).find((template) => template.isDefault)?.key ??
    "quick_note"
  );
}

export function resolveNoteTemplateDefinition(
  templateKey: string | null | undefined,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  const normalizedKey = normalizeNoteTemplateKey(templateKey, snapshot);
  const matched = snapshot?.recordTypes.find((recordType) => recordType.key === normalizedKey);

  if (matched) {
    return buildDefinitionFromRecord(matched);
  }

  return (
    NOTE_TEMPLATES[normalizedKey] ?? {
      key: normalizedKey,
      label: "记录",
      colorKey: "slate",
      eyebrow: NOTE_EYEBROW,
      description: "按你的方式记录并整理内容。",
      defaultTitle: NOTE_DEFAULT_TITLE,
      placeholder: NOTE_PLACEHOLDER,
      emptyStateText: NOTE_EMPTY_STATE_TEXT,
      defaultHtml: EMPTY_EDITOR_HTML,
      isDefault: false,
    }
  );
}

export function noteTemplateLabel(
  templateKey: string,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  return resolveNoteTemplateDefinition(templateKey, snapshot).label;
}

export function noteTemplateDescription(
  templateKey: string,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  return resolveNoteTemplateDefinition(templateKey, snapshot).description;
}

export function noteTemplateColorKey(
  templateKey: string,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  return resolveNoteTemplateDefinition(templateKey, snapshot).colorKey;
}

export function noteTemplateDefaultTitle(
  templateKey: NoteTemplateKey,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  return resolveNoteTemplateDefinition(templateKey, snapshot).defaultTitle;
}

export function noteTemplatePlaceholder(
  templateKey: NoteTemplateKey,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  return resolveNoteTemplateDefinition(templateKey, snapshot).placeholder;
}

export function noteTemplateEmptyState(
  templateKey: NoteTemplateKey,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  return resolveNoteTemplateDefinition(templateKey, snapshot).emptyStateText;
}

export function noteTemplateDefaultHtml(
  templateKey: NoteTemplateKey,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  return resolveNoteTemplateDefinition(templateKey, snapshot).defaultHtml;
}

export function createDraftNote(
  templateKey?: NoteTemplateKey,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  const nextTemplateKey = templateKey ?? defaultNoteTemplateKey(snapshot);
  return {
    localId: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    noteType: nextTemplateKey,
    title: "",
    contentMarkdown: "",
    contentHtml: noteTemplateDefaultHtml(nextTemplateKey, snapshot),
  };
}

export function isDefaultNoteTitle(
  title: string | null | undefined,
  templateKey: NoteTemplateKey,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  const normalized = title?.trim();

  if (!normalized) {
    return true;
  }

  return normalized === noteTemplateDefaultTitle(templateKey, snapshot);
}

export function getRenderableNoteHtml(note: Pick<NoteRecord, "contentHtml" | "contentMarkdown">) {
  return getRenderableRichTextHtml({
    html: note.contentHtml,
    markdown: note.contentMarkdown,
  });
}

export function getEditableNoteHtml(note: Pick<NoteRecord, "contentHtml" | "contentMarkdown">) {
  return getEditableRichTextHtml({
    html: note.contentHtml,
    markdown: note.contentMarkdown,
  });
}

export function summarizeNoteContent(note: Pick<NoteRecord, "contentHtml" | "contentMarkdown">) {
  const normalized = richTextHtmlToPlainText(getRenderableNoteHtml(note));
  return normalized.length > 0 ? normalized.slice(0, 96) : "尚未填写内容";
}

export function normalizeNoteTitleInput(
  title: string | null | undefined,
  templateKey: NoteTemplateKey,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  const normalized = title?.trim() ?? "";

  if (!normalized || isDefaultNoteTitle(normalized, templateKey, snapshot)) {
    return "";
  }

  return normalized;
}

export function deriveNoteTitleFromContent(
  note: Pick<NoteRecord, "contentHtml" | "contentMarkdown">,
  templateKey: NoteTemplateKey,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  const htmlCandidate = deriveNoteTitleFromHtml(getRenderableNoteHtml(note));

  if (htmlCandidate) {
    return htmlCandidate;
  }

  const markdownCandidate = deriveNoteTitleFromMarkdown(note.contentMarkdown);

  if (markdownCandidate) {
    return markdownCandidate;
  }

  return noteTemplateLabel(templateKey, snapshot);
}

export function resolveNoteDisplayTitle(
  note: Pick<NoteRecord, "title" | "contentHtml" | "contentMarkdown">,
  templateKey: NoteTemplateKey,
  snapshot?: RecordTypeSettingsSnapshot | null,
) {
  const explicitTitle = normalizeNoteTitleInput(note.title, templateKey, snapshot);

  if (explicitTitle) {
    return explicitTitle;
  }

  return deriveNoteTitleFromContent(note, templateKey, snapshot);
}

export function normalizeNoteTemplateKey(
  templateKey: string | null | undefined,
  snapshot?: RecordTypeSettingsSnapshot | null,
): NoteTemplateKey {
  const normalized = templateKey?.trim();
  return normalized?.length ? normalized : defaultNoteTemplateKey(snapshot);
}

export function plainTextToHtml(source: string) {
  const normalized = source.trim();

  if (!normalized) {
    return EMPTY_EDITOR_HTML;
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`);

  return paragraphs.join("");
}

function buildDefinitionFromRecord(recordType: RecordTypeRecord): NoteTemplateDefinition {
  const fallback = NOTE_TEMPLATES[recordType.key];

  return {
    key: recordType.key,
    label: recordType.label,
    colorKey: recordType.colorKey,
    eyebrow: fallback?.eyebrow ?? NOTE_EYEBROW,
    description: fallback?.description ?? "按你的方式记录并整理内容。",
    defaultTitle: fallback?.defaultTitle ?? NOTE_DEFAULT_TITLE,
    placeholder: fallback?.placeholder ?? NOTE_PLACEHOLDER,
    emptyStateText: fallback?.emptyStateText ?? NOTE_EMPTY_STATE_TEXT,
    defaultHtml: recordType.templateHtml.trim() || fallback?.defaultHtml || EMPTY_EDITOR_HTML,
    isDefault: recordType.isDefault,
  };
}

function escapeHtml(source: string) {
  return source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const NOTE_TITLE_SKIP_SET = new Set(["背景", "讨论要点", "初步结论", "行动项"]);

function deriveNoteTitleFromHtml(html: string) {
  const normalized = html.trim();

  if (!normalized) {
    return "";
  }

  if (typeof DOMParser === "undefined") {
    return "";
  }

  const doc = new DOMParser().parseFromString(normalized, "text/html");
  const blocks = Array.from(
    doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, th"),
  );

  for (const block of blocks) {
    const lines = (block.textContent ?? "")
      .split(/\r?\n/)
      .map((line) => finalizeNoteTitleCandidate(line))
      .filter((line) => line.length > 0);

    if (lines[0]) {
      return lines[0];
    }
  }

  return "";
}

function deriveNoteTitleFromMarkdown(markdown: string) {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => stripMarkdownDecorations(line))
    .map((line) => finalizeNoteTitleCandidate(line))
    .filter((line) => line.length > 0);

  return lines[0] ?? "";
}

function stripMarkdownDecorations(source: string) {
  return source
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)/, "")
    .replace(/\|/g, " ")
    .replace(/[*_~`]/g, " ");
}

function finalizeNoteTitleCandidate(source: string) {
  let normalized = source.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  for (const heading of NOTE_TITLE_SKIP_SET) {
    if (normalized === heading) {
      return "";
    }

    if (normalized.startsWith(heading) && normalized.length > heading.length) {
      const stripped = normalized
        .slice(heading.length)
        .replace(/^[:：\-]\s*/, "")
        .trim();

      if (stripped.length > 0) {
        normalized = stripped;
      }
    }
  }

  const firstSentenceMatch = normalized.match(/^(.+?[。！？!?])(?=\s|$|["'”’])/u);
  const firstSentence = firstSentenceMatch?.[1]?.trim();
  const candidate = firstSentence || normalized;

  return candidate.length > 48 ? `${candidate.slice(0, 48).trimEnd()}…` : candidate;
}
