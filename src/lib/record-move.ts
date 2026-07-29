import { EMPTY_RICH_TEXT_HTML, getEditableRichTextHtml } from "./richTextContent";

export function appendMarkdownSection(existingMarkdown: string | undefined, markdownToAppend: string) {
  const existing = existingMarkdown?.trim() ?? "";
  const addition = markdownToAppend.trim();

  if (!existing) {
    return addition;
  }

  if (!addition) {
    return existing;
  }

  return `${existing}\n\n---\n\n${addition}`;
}

export function appendRichTextSection(
  existing: { html?: string | null; markdown?: string | null },
  htmlToAppend: string,
) {
  const currentHtml = getEditableRichTextHtml(existing).trim();
  const addition = htmlToAppend.trim();

  if (!addition || addition === EMPTY_RICH_TEXT_HTML) {
    return currentHtml || EMPTY_RICH_TEXT_HTML;
  }

  if (!currentHtml || currentHtml === EMPTY_RICH_TEXT_HTML) {
    return addition;
  }

  return `${currentHtml}<hr>${addition}`;
}
