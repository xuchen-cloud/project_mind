import type { AiAnswerScope } from "./types";

export interface AskScopeContext {
  defaultScope: AiAnswerScope;
  allowedScopes: AiAnswerScope[];
}

export function askScopeLabel(scope: AiAnswerScope) {
  switch (scope) {
    case "project":
      return "当前项目";
    case "workspace":
    default:
      return "工作台";
  }
}

export function deriveAskScopeContext(
  pathname: string,
  projectId: number | null,
): AskScopeContext {
  if (projectId !== null && pathname.startsWith("/projects/")) {
    return {
      defaultScope: "project",
      allowedScopes: ["project", "workspace"],
    };
  }

  return {
    defaultScope: "workspace",
    allowedScopes: ["workspace"],
  };
}
