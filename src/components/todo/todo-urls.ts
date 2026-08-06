import { desktopApi } from "../../services/desktopApi";

export type TodoUrlTextSegment =
  | { type: "text"; text: string }
  | { type: "url"; text: string; href: string };

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'），。！？；、》】\],!;}]+/giu;
const SURROUNDING_TRAILING_PUNCTUATION = /[),.!?;:\]}>，。！？；：、》】]+$/u;

export function splitTodoUrlText(source: string): TodoUrlTextSegment[] {
  const segments: TodoUrlTextSegment[] = [];
  let cursor = 0;

  for (const match of source.matchAll(HTTP_URL_PATTERN)) {
    const start = match.index ?? 0;
    const href = match[0].replace(SURROUNDING_TRAILING_PUNCTUATION, "");
    if (!isCompleteHttpUrl(href)) continue;

    if (start > cursor) {
      segments.push({ type: "text", text: source.slice(cursor, start) });
    }
    segments.push({ type: "url", text: href, href });
    cursor = start + href.length;
  }

  if (cursor < source.length) {
    segments.push({ type: "text", text: source.slice(cursor) });
  }
  return segments.length > 0 ? segments : [{ type: "text", text: source }];
}

export function openTodoUrl(href: string) {
  return desktopApi.openExternalUrl(href);
}

function isCompleteHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
