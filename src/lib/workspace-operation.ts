import type { QueryClient } from "@tanstack/react-query";
import type { AgentWorkspaceBinding } from "./agent-types";
import type { WorkspaceStatusSnapshot } from "./types";
import { queryKeys } from "./queryKeys";
import { recordDocumentApi } from "../services/recordDocumentApi";

export class WorkspaceOperationExpiredError extends Error {
  constructor() {
    super("工作区已切换，请在当前工作区重新操作");
    this.name = "WorkspaceOperationExpiredError";
  }
}

/** Capture before the first await; removing the binding query retires this open. */
export function createWorkspaceOperation(client: QueryClient, bindingGet = recordDocumentApi.bindingGet) {
  const currentRoot = () => client.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath;
  const root = currentRoot();
  if (!root) throw new Error("当前没有工作区");
  const queryKey = queryKeys.projectContentBinding(root);
  const pending = client.fetchQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const binding = await bindingGet(root);
      signal.throwIfAborted();
      return binding;
    },
    staleTime: Infinity,
    // An in-flight mutation can outlive its last mounted view. Workspace
    // lifecycle removal, rather than observer GC, retires this identity.
    gcTime: Infinity,
    retry: false,
  });
  const query = client.getQueryCache().find({ queryKey, exact: true });
  let captured: AgentWorkspaceBinding | undefined;
  const isCurrent = () => {
    const binding = client.getQueryData<AgentWorkspaceBinding>(queryKey);
    return currentRoot() === root
      && client.getQueryCache().find({ queryKey, exact: true }) === query
      && (!captured || (binding?.workspaceId === captured.workspaceId && binding.generation === captured.generation));
  };
  const assertCurrent = () => {
    if (!isCurrent()) throw new WorkspaceOperationExpiredError();
  };
  const binding = pending.then(value => {
    captured = value;
    assertCurrent();
    return value;
  }, error => {
    assertCurrent();
    throw error;
  });
  return { binding, isCurrent, assertCurrent };
}

export async function withWorkspaceBinding<T>(client: QueryClient, task: (binding: AgentWorkspaceBinding) => Promise<T>): Promise<T> {
  const operation = createWorkspaceOperation(client);
  try {
    return await task(await operation.binding);
  } finally {
    operation.assertCurrent();
  }
}
