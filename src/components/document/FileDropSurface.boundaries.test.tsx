import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileDropSurface } from "./FileDropSurface";
import { RichEditor } from "../rich-editor/RichEditor";
import { HomeProjectFiles } from "../home/HomeProjectFiles";
import { createUiStoreState, useUiStore } from "../../state/ui-store";
import type { ProjectSidebarDocumentItem } from "../layout/ProjectSidebar";
const host = vi.hoisted(() => ({ command: vi.fn(), file: vi.fn() }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { command: host.command, fileCommand: host.file, listenEvent: vi.fn(async () => () => {}) } }));
const transfer = () => ({ types: ["Files"], files: [{ path: "/external/image.png" }], getData: () => "" });
function mount(content: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><main className="workspace-content-main"><FileDropSurface workspaceRoot="/workspace" projectId={7} main />{content}</main></QueryClientProvider>);
}
const originalHitTest = document.elementFromPoint;
afterEach(() => Object.defineProperty(document, "elementFromPoint", { configurable: true, value: originalHitTest }));
beforeEach(() => {
  // jsdom has no layout hit-testing. No caret hit means no drop-cursor move;
  // the real editor DOM and its event propagation remain mounted.
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
  useUiStore.setState(createUiStoreState()); host.command.mockReset(); host.file.mockReset();
  host.command.mockImplementation(async (command, args) => {
    if (command === "record_workspace_binding_get") return { apiVersion: 1, requestId: args.input.requestId, ok: true, data: { workspaceId: "w", generation: "g" } };
    if (command === "project_tag_settings_get") return { tags: [] };
    if (command === "project_directory_list") return [{ kind: "file", name: "brief.md", relativePath: "brief.md", bytes: 1 }];
    if (command === "file_editors_flush" || command === "file_editors_release") return { apiVersion: 1, requestId: args.input.requestId, ok: true, data: null };
    return [];
  });
  host.file.mockImplementation(async command => command === "file_drop_prepare" ? { intentId: "intent" } : { documentId: 4, versionNumber: 4, contentHash: "h", noChange: false, cleanupWarning: null, oldSessionsClosed: true });
});
it("lets a real RichEditor receive image/file drop inside the main content without consuming it", async () => {
  const received = vi.fn((event: React.DragEvent) => event.stopPropagation());
  const view = mount(<div className="project-content__file-page" onDropCapture={received}><RichEditor variant="bare" defaultHtml="<p>Original text</p>" /></div>);
  const editor = await waitFor(() => {
    const element = view.container.querySelector<HTMLElement>('[contenteditable="true"]'); expect(element).not.toBeNull(); return element!;
  });
  fireEvent.dragOver(editor, { dataTransfer: transfer() });
  fireEvent.drop(editor, { dataTransfer: transfer() });
  expect(received).toHaveBeenCalledOnce();
  expect(host.file).not.toHaveBeenCalled();
  expect(host.command.mock.calls.some(([command]) => command === "record_workspace_binding_get")).toBe(false);
  expect(screen.queryByText("松手移入文件，成功后原文件移至回收站")).toBeNull();
});
it("does not consume Record, Markdown/Office editor, or settings drop", () => {
  const received = vi.fn();
  mount(<><div className="project-content__page" data-content-object="record:4" onDrop={received}>Record</div><div className="project-content__file-page"><div className="office-file-content markdown-file-content" onDrop={received}>Markdown</div></div><section onDrop={received}>Settings</section></>);
  for (const text of ["Record", "Markdown", "Settings"]) {
    fireEvent.dragOver(screen.getByText(text), { dataTransfer: transfer() });
    fireEvent.drop(screen.getByText(text), { dataTransfer: transfer() });
  }
  expect(received).toHaveBeenCalledTimes(3);
  expect(host.file).not.toHaveBeenCalled();
});
const managedFile: ProjectSidebarDocumentItem = { id: 4, projectId: 7, name: "brief.md", baseName: "brief", mimeType: "text/markdown", managedPath: "/project/brief.md", originalPath: "/project/brief.md", historyDirPath: "/history", isStarred: false, currentVersionNumber: 3, versionCount: 1, health: "normal", tags: [] };
it("uses the real managed list and physical tree row baselines for update, and their blank area for add", async () => {
  mount(<HomeProjectFiles fileScope={{ workspaceRoot: "/workspace", projectId: 7, rootPath: "/project", name: "Project" }} documents={[managedFile]} />);
  const transferMd = { ...transfer(), files: [{ path: "/external/new.md" }] };
  const listRow = screen.getByRole("button", { name: "brief" });
  fireEvent.dragOver(listRow, { dataTransfer: transferMd });
  await screen.findByText(/更新此文件版本 · brief.md · v3/);
  fireEvent.drop(listRow, { dataTransfer: transferMd });
  await waitFor(() => expect(host.file).toHaveBeenCalledWith("file_drop_prepare", expect.objectContaining({ target: { kind: "update", documentId: 4, projectId: 7, managedPath: "/project/brief.md", expectedVersionNumber: 3 } })));
  host.file.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "文件树展示" }));
  const treeRow = await screen.findByRole("button", { name: "brief.md" });
  fireEvent.dragOver(treeRow, { dataTransfer: transferMd });
  await screen.findByText(/更新此文件版本 · brief.md · v3/);
  fireEvent.drop(treeRow, { dataTransfer: transferMd });
  await waitFor(() => expect(host.file).toHaveBeenCalledWith("file_drop_prepare", expect.objectContaining({ target: expect.objectContaining({ kind: "update", expectedVersionNumber: 3 }) })));
  host.file.mockClear();
  const treeBlank = screen.getByRole("region", { name: "项目目录内容" });
  fireEvent.dragEnter(treeBlank, { dataTransfer: transferMd });
  fireEvent.drop(treeBlank, { dataTransfer: transferMd });
  await waitFor(() => expect(host.file).toHaveBeenCalledWith("file_drop_prepare", expect.objectContaining({ target: { kind: "new", owner: 7, name: "new.md" } })));
});
