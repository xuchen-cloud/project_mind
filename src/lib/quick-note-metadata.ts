import { extractHashTagLabels } from "./tags";

export function deriveQuickNoteMetadata(markdown: string): {
  title: string | undefined;
  tagLabels: string[];
} {
  const lines = markdown.split(/\r?\n/u);
  const first = lines.find((line) => line.trim())?.trim() ?? "";
  const heading = first.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim();
  const candidate = (heading ?? first).replace(/(?:^|\s)[#＃][^\s#＃]+/gu, "").trim();
  const title = candidate.length >= 2 && candidate.length <= 36 &&
      !/[。！？.!?;；:]$/u.test(candidate) &&
      !/^[-*+]\s|^\d+\.\s/u.test(candidate)
    ? candidate
    : undefined;

  let fence: "`" | "~" | null = null;
  const prose: string[] = [];
  for (const line of lines) {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      const kind = marker[0] as "`" | "~";
      if (fence === null) fence = kind;
      else if (fence === kind) fence = null;
      continue;
    }
    if (fence) continue;
    prose.push(line.replace(/`[^`]*`/gu, ""));
  }

  return { title, tagLabels: extractHashTagLabels(prose.join("\n")) };
}
