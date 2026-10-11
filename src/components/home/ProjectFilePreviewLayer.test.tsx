import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectFilePreviewLayer } from "./ProjectFilePreviewLayer";
import { openProjectFilePreview, useProjectFileNavigation } from "../../lib/project-file-navigation";
import { projectDirectoryApi } from "../../services/projectDirectoryApi";
vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: { resolveReference: vi.fn(), preview: vi.fn(), open: vi.fn() } }));
vi.mock("../../lib/dsh-host-events", () => ({ requestDshFileReference: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks(); useProjectFileNavigation.setState({ request: null, revisions: {} });
  vi.mocked(projectDirectoryApi.resolveReference).mockResolvedValue("notes/context.txt");
  vi.mocked(projectDirectoryApi.preview).mockResolvedValue({ kind: "text", text: "actual project content", bytes: 22 });
});
it("opens an assistant absolute link through the project authority and shared main preview", async () => {
  render(<ProjectFilePreviewLayer currentProjectId={7} />);
  act(() => openProjectFilePreview(7, "/actual/project/notes/context.txt", 3));
  expect(await screen.findByText("actual project content")).toBeVisible();
  expect(projectDirectoryApi.resolveReference).toHaveBeenCalledWith(7, "/actual/project/notes/context.txt");
  expect(projectDirectoryApi.preview).toHaveBeenCalledWith(7, "notes/context.txt");
  fireEvent.click(screen.getByRole("button", { name: "关闭对话框" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("discards a file resolution from the previous project after navigation", async () => {
  let resolve!: (path: string) => void;
  vi.mocked(projectDirectoryApi.resolveReference).mockImplementation(() => new Promise(done => { resolve = done; }));
  const view = render(<ProjectFilePreviewLayer currentProjectId={7} />);
  act(() => openProjectFilePreview(7, "notes/context.txt"));
  await screen.findByRole("dialog");
  view.rerender(<ProjectFilePreviewLayer currentProjectId={8} />);
  await act(async () => resolve("old-project-secret.txt"));
  expect(projectDirectoryApi.preview).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(useProjectFileNavigation.getState().request).toBeNull();
});
it("surfaces refusal for links outside the project without opening another viewer", async () => {
  vi.mocked(projectDirectoryApi.resolveReference).mockRejectedValue(new Error("文件引用位于当前项目目录之外"));
  render(<ProjectFilePreviewLayer currentProjectId={7} />);
  act(() => openProjectFilePreview(7, "/outside/secret.txt"));
  expect(await screen.findByRole("alert")).toHaveTextContent("当前项目目录之外");
  expect(projectDirectoryApi.preview).not.toHaveBeenCalled();
});
