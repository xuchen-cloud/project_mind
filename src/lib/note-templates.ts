import type { NoteRecord } from "./types";
import {
  EMPTY_RICH_TEXT_HTML,
  getEditableRichTextHtml,
  getRenderableRichTextHtml,
  richTextHtmlToPlainText,
} from "./richTextContent";

const EMPTY_EDITOR_HTML = EMPTY_RICH_TEXT_HTML;
const NOTE_DEFAULT_TITLE = "记录";
const NOTE_PLACEHOLDER = "想到就写，先把信息记下来。";
const NOTE_EMPTY_STATE_TEXT = "还没有记录。";

export function noteLabel() {
  return NOTE_DEFAULT_TITLE;
}

export function notePlaceholder() {
  return NOTE_PLACEHOLDER;
}

export function noteEmptyStateText() {
  return NOTE_EMPTY_STATE_TEXT;
}

export function noteDefaultHtml() {
  return EMPTY_EDITOR_HTML;
}

export function isDefaultNoteTitle(title: string | null | undefined) {
  const normalized = title?.trim();
  return !normalized || normalized === NOTE_DEFAULT_TITLE;
}

export function normalizeNoteTitleInput(title: string | null | undefined) {
  const normalized = title?.trim() ?? "";
  if (!normalized || isDefaultNoteTitle(normalized)) {
    return "";
  }
  return normalized;
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
