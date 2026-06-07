import type {
  AiAnswerCitationRecord,
  AiArtifactCitationRecord,
  AiArtifactGetInput,
  AiArtifactKind,
} from "./types";
import { projectPath } from "./formatters";

type AiCitationRecord = AiArtifactCitationRecord | AiAnswerCitationRecord;

export function aiArtifactQueryKey(input: AiArtifactGetInput) {
  return [
    "ai-artifact",
    input.kind,
    input.projectId ?? null,
    input.artifactDate ?? null,
  ] as const;
}

export function workspaceDayString(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function artifactTitle(kind: AiArtifactKind) {
  switch (kind) {
    case "project_brief":
      return "项目概览";
    case "daily_brief":
      return "今日概览";
    default:
      return "AI 概览";
  }
}

export function citationPath(citation: AiCitationRecord) {
  const projectId =
    citation.projectId ?? (citation.sourceKind === "project" ? citation.sourceId : null);

  if (!projectId) {
    return null;
  }

  switch (citation.sourceKind) {
    case "project":
      return projectPath(projectId);
    case "note":
      return projectPath(projectId);
    case "conclusion":
      return projectPath(projectId, `conclusion-${citation.sourceId}`);
    case "todo":
      return projectPath(projectId, `todo-${citation.sourceId}`);
    case "document":
      return projectPath(projectId, `document-${citation.sourceId}`);
    default:
      return projectPath(projectId);
  }
}
