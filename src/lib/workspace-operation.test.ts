import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { queryKeys } from "./queryKeys";
import { withWorkspaceBinding } from "./workspace-operation";
import { projectMindApi } from "../services/projectMindApi";

vi.mock("../services/recordDocumentApi", () => ({
  recordDocumentApi: { bindingGet: async () => ({ workspaceId: "w", generation: "g" }) },
}));
vi.mock("../services/projectMindApi", () => ({
  projectMindApi: { projectTagUpsert: vi.fn() },
}));

it("rejects a pending tag response when the Workspace binding query is retired at the same root", async () => {
  const client = new QueryClient();
  const binding = { workspaceId: "w", generation: "g" };
  const queryKey = queryKeys.projectContentBinding("/workspace");
  client.setQueryData(queryKeys.workspaceStatus, { currentWorkspace: { rootPath: "/workspace" } });
  let finish!: (tag: Awaited<ReturnType<typeof projectMindApi.projectTagUpsert>>) => void;
  vi.mocked(projectMindApi.projectTagUpsert).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const request = withWorkspaceBinding(client, captured => projectMindApi.projectTagUpsert({ projectId: 7, label: "budget", colorKey: "blue" }, captured));
  const rejected = expect(request).rejects.toThrow("工作区已切换，请在当前工作区重新操作");
  await vi.waitFor(() => expect(projectMindApi.projectTagUpsert).toHaveBeenCalledWith(
    { projectId: 7, label: "budget", colorKey: "blue" }, binding,
  ));

  client.removeQueries({ queryKey, exact: true });
  client.setQueryData(queryKey, binding);
  finish({ id: 9, label: "budget", colorKey: "blue", usageCount: 0, createdAt: "", updatedAt: "" });

  await rejected;
  client.clear();
});
