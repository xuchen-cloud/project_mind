import type { DocumentRecord, TodoRecord } from "./types";

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatRelativeSessionTime(value: string) {
  const date = new Date(value);
  const delta = Date.now() - date.getTime();
  const minutes = Math.round(delta / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "Yesterday";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

export function formatOverviewDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(value))
    .replace(",", " •");
}

export function formatDocumentMeta(document: DocumentRecord) {
  const extension = document.name.includes(".")
    ? document.name.split(".").pop()?.toUpperCase()
    : null;
  const relative = formatRelativeSessionTime(document.updatedAt);
  return extension ? `${extension} • ${relative}` : relative;
}

export function formatTaskDate(todo: TodoRecord) {
  const source = todo.updatedAt || todo.createdAt;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(source),
  );
}

export function roundToHalfHourLocal() {
  const now = new Date();
  const minutes = now.getMinutes();
  const rounded = minutes < 30 ? 30 : 60;
  now.setMinutes(rounded, 0, 0);
  if (rounded === 60) now.setHours(now.getHours() + 1, 0, 0, 0);
  return now.toISOString().slice(0, 16);
}

export function buildConclusionPreview(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return { heading: "", body: "" };
  const sentenceMatch = normalized.match(/^(.{1,48}?)[。！？.!?]\s*(.+)$/u);
  if (sentenceMatch) return { heading: sentenceMatch[1].trim(), body: sentenceMatch[2].trim() };
  const lineMatch = normalized.match(/^(.{1,48})[:：-]\s*(.+)$/u);
  if (lineMatch) return { heading: lineMatch[1].trim(), body: lineMatch[2].trim() };
  return { heading: "", body: normalized };
}

export function latestTodoSummary(todo: TodoRecord) {
  return todo.progresses[0]?.content || "等待补充进展";
}

export function taskTone(todo: TodoRecord) {
  if (todo.status === "finished") return "complete";
  if (todo.priority === "urgent_important" || todo.priority === "urgent_not_important") {
    return "critical";
  }
  return "active";
}

export function fileHref(path: string) {
  const normalized = path.replace(/\\/g, "/");

  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }

  if (normalized.startsWith("//")) {
    return `file:${encodeURI(normalized)}`;
  }

  return `file://${encodeURI(normalized)}`;
}

export function fileUriToPath(fileUri: string) {
  try {
    const url = new URL(fileUri);
    if (url.protocol !== "file:") {
      return "";
    }

    const pathname = decodeURIComponent(url.pathname);
    if (url.host && url.host.toLowerCase() !== "localhost") {
      return `\\\\${url.host}${pathname.replace(/\//g, "\\")}`;
    }

    if (/^\/[A-Za-z]:\//.test(pathname)) {
      return pathname.slice(1).replace(/\//g, "\\");
    }

    return pathname;
  } catch {
    const fallback = fileUri.replace(/^file:\/\//, "");

    try {
      const decoded = decodeURIComponent(fallback);

      if (decoded.startsWith("//")) {
        return `\\\\${decoded.slice(2).replace(/\//g, "\\")}`;
      }

      if (/^[A-Za-z]:\//.test(decoded)) {
        return decoded.replace(/\//g, "\\");
      }

      return decoded;
    } catch {
      return fallback;
    }
  }
}

export function projectPath(projectId: number, focus?: string) {
  return focus
    ? `/projects/${projectId}?focus=${encodeURIComponent(focus)}`
    : `/projects/${projectId}`;
}

export function recordPath(projectId: number, noteId: number) {
  return `/projects/${projectId}/records/${noteId}`;
}

export function recordFocusId(noteId: number) {
  return `record-${noteId}`;
}

export function parseFocusRecordId(focus: string | null) {
  const match = focus?.match(/^record-(\d+)$/u);
  return match ? Number(match[1]) : null;
}

export function workspacePath() {
  return "/workspace";
}

export function parseRouteId(value?: string) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
