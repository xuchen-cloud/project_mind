import { beforeEach, expect, it } from "vitest";
import { fileNavigationScopeKey, notifyProjectFilesChanged, openProjectFilePreview, useProjectFileNavigation } from "./project-file-navigation";
beforeEach(() => useProjectFileNavigation.setState({ request: null, revisions: {} }));
it("isolates Workspace and Project file refreshes and captures the originating Workspace in navigation", () => {
  notifyProjectFilesChanged(null, "/workspace/a");
  notifyProjectFilesChanged(7, "/workspace/a");
  notifyProjectFilesChanged(null, "/workspace/b");
  notifyProjectFilesChanged(null, "/workspace/a");
  const revisions = useProjectFileNavigation.getState().revisions;
  expect(revisions[fileNavigationScopeKey(null, "/workspace/a")]).toBe(2);
  expect(revisions[fileNavigationScopeKey(7, "/workspace/a")]).toBe(1);
  expect(revisions[fileNavigationScopeKey(null, "/workspace/b")]).toBe(1);
  openProjectFilePreview(null, "plan.md", undefined, undefined, undefined, "/workspace/a");
  expect(useProjectFileNavigation.getState().request).toMatchObject({ workspaceRoot: "/workspace/a", projectId: null, path: "plan.md" });
});
