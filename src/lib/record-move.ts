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
