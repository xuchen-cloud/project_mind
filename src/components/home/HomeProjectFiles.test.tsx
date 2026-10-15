import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HomeProjectFiles } from "./HomeProjectFiles";
import type { ProjectSidebarDocumentItem } from "../layout/ProjectSidebar";
import { createUiStoreState, useUiStore } from "../../state/ui-store";

vi.mock("../../hooks/useDocumentMutations", () => ({ useDocumentMutations: () => ({
  documentMetaMutation: { mutate: vi.fn(), isPending: false },
  documentAddVersionMutation: { mutate: vi.fn(), isPending: false },
  documentDeleteMutation: { mutate: vi.fn(), isPending: false },
}) }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { projectTagSettingsGet: async () => ({ tags: [] }) } }));
vi.mock("../../services/projectDirectoryApi", () => ({ projectDirectoryApi: {
  list: async (_id: number, path: string) => path === "" ? [{ name: "generated", relativePath: "generated", kind: "directory", bytes: 0 }] : [
    { name: "result.txt", relativePath: "generated/result.txt", kind: "file", bytes: 1 },
    { name: "other.txt", relativePath: "generated/other.txt", kind: "file", bytes: 1 },
  ],
} }));
const documents: ProjectSidebarDocumentItem[] = [41, 42].map((id, index) => ({
  id, projectId: 7, name: index ? "other.txt" : "result.txt", baseName: index ? "other.txt" : "result.txt", mimeType: "text/plain",
  managedPath: `/project/generated/${index ? "other.txt" : "result.txt"}`, originalPath: "", historyDirPath: "", isStarred: false,
  currentVersionNumber: 1, versionCount: 0, health: "normal", tags: index ? [] : [{ id: 9, label: "交付", colorKey: "blue" }],
}));
beforeEach(() => useUiStore.setState(createUiStoreState()));
it("keeps focus across flat/tree presentation, hides tag chips, and retains flat tag filters", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const component = (id: number | null, path: string | null, tagId: number | null = null) => <QueryClientProvider client={client}>
    <HomeProjectFiles project={{ id: 7, name: "Project", rootPath: "/project" }} documents={documents}
      activeFileId={id} activeRelativePath={path} filter={{ query: "", tagId }} />
  </QueryClientProvider>;
  const view = render(component(41, "generated/result.txt"));
  const flat = screen.getByRole("region", { name: "项目文件列表" });
  expect(within(flat).getByRole("button", { name: /^result.txt/ })).toHaveClass("is-active");
  expect(within(flat).queryByText("交付", { exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  expect(await screen.findByRole("button", { name: "result.txt", exact: true })).toHaveClass("is-active");
  expect(within(screen.getByRole("region", { name: "项目目录内容" })).queryByText("交付", { exact: true })).toBeNull();
  view.rerender(component(42, "generated/other.txt"));
  expect(screen.getByRole("button", { name: "result.txt", exact: true })).not.toHaveClass("is-active");
  expect(screen.getByRole("button", { name: "other.txt", exact: true })).toHaveClass("is-active");
  fireEvent.click(screen.getByRole("button", { name: "平铺展示" }));
  expect(screen.getByRole("button", { name: "other.txt", exact: true })).toHaveClass("is-active");
  view.rerender(component(null, null, 9));
  expect(screen.queryByRole("button", { name: "other.txt", exact: true })).toBeNull();
  expect(screen.getByRole("button", { name: /^result.txt/ })).not.toHaveClass("is-active");
  expect(within(screen.getByRole("region", { name: "项目文件列表" })).queryByText("交付", { exact: true })).toBeNull();
});
