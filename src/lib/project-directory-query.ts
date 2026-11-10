import type { AgentWorkspaceBinding } from "./agent-types";
import { queryKeys } from "./queryKeys";

export function projectDirectoryQueryKey(rootPath: string, projectId: number | null, relativePath: string,
  workspaceRoot: string | undefined, binding: AgentWorkspaceBinding | undefined) {
  return [...queryKeys.projectDirectory(rootPath, projectId, relativePath, 0), workspaceRoot,
    ...(binding ? [binding.workspaceId, binding.generation] : [])];
}

export function matchesDirectoryQueryBinding(key: readonly unknown[], workspaceRoot: string | undefined,
  binding: AgentWorkspaceBinding | undefined) {
  return key[5] === workspaceRoot
    && (!binding || (key[6] === binding.workspaceId && key[7] === binding.generation));
}
