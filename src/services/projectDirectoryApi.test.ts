import { expect, it, vi } from "vitest";
import { projectDirectoryApi } from "./projectDirectoryApi";
import { desktopApi } from "./desktopApi";
vi.mock("./desktopApi", () => ({ desktopApi: { command: vi.fn().mockResolvedValue(undefined) } }));
it("passes project identity and relative paths without accepting a frontend root path", async () => {
  await projectDirectoryApi.list(7);
  expect(desktopApi.command).toHaveBeenLastCalledWith("project_directory_list", { projectId: 7, relativePath: "" });
  await projectDirectoryApi.preview(7, "sub/file.txt");
  expect(desktopApi.command).toHaveBeenLastCalledWith("project_directory_preview", { projectId: 7, relativePath: "sub/file.txt" });
  await projectDirectoryApi.resolveReference(7, "/project/sub/file.txt");
  expect(desktopApi.command).toHaveBeenLastCalledWith("project_directory_resolve_reference", { projectId: 7, reference: "/project/sub/file.txt" });
  await projectDirectoryApi.open(7, "sub/file.txt");
  expect(desktopApi.command).toHaveBeenLastCalledWith("project_directory_open", { projectId: 7, relativePath: "sub/file.txt" });
});
