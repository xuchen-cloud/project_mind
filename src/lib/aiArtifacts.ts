import type {
  AiAnswerCitationRecord,
  AiArtifactCitationRecord,
  AiArtifactGetInput,
  AiArtifactKind,
} from "./types";
import { activityPath, projectPath } from "./formatters";

type AiCitationRecord = AiArtifactCitationRecord | AiAnswerCitationRecord;

export function aiArtifactQueryKey(input: AiArtifactGetInput) {
  return [
    "ai-artifact",
    input.kind,
    input.projectId ?? null,
    input.activityId ?? null,
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
    case "activity_summary":
      return "活动总结";
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
  const activityId =
    citation.activityId ?? (citation.sourceKind === "activity" ? citation.sourceId : null);

  if (!projectId) {
    return null;
  }

  switch (citation.sourceKind) {
    case "project":
      return projectPath(projectId);
    case "activity":
      return activityId ? activityPath(projectId, activityId) : projectPath(projectId);
    case "note":
      return activityId
        ? activityPath(projectId, activityId, `note-${citation.sourceId}`)
        : projectPath(projectId);
    case "conclusion":
      return activityId
        ? activityPath(projectId, activityId, `conclusion-${citation.sourceId}`)
        : projectPath(projectId, `conclusion-${citation.sourceId}`);
    case "todo":
      return activityId
        ? activityPath(projectId, activityId, `todo-${citation.sourceId}`)
        : projectPath(projectId, `todo-${citation.sourceId}`);
    case "document":
      return activityId
        ? activityPath(projectId, activityId, `document-${citation.sourceId}`)
        : projectPath(projectId, `document-${citation.sourceId}`);
    default:
      return projectPath(projectId);
  }
}
