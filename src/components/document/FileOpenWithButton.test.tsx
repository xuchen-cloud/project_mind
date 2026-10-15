import { act, fireEvent, render as renderUi, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { fileApplicationOptions } from "../../hooks/useFileApplications";
import { beforeEach, expect, it, vi } from "vitest";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { FileOpenWithButton } from "./FileOpenWithButton";

vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { applications: vi.fn(), openWith: vi.fn() } }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
const props = { workspaceRoot: "/workspace", projectId: 2, fileId: 7, fileName: "first.txt", visible: true, onOpen: vi.fn() };
let client: QueryClient;
function render(ui: ReactElement) { return renderUi(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> }); }
const icon = "data:image/png;base64,iVBORw0KGgo=";
const applications = [{ id: "/Applications/Viewer.app", name: "Viewer", icon, isDefault: true }, { id: "/Applications/Editor.app", name: "Editor", icon: null, isDefault: false }];
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectFileApi.applications).mockResolvedValue(applications);
});

it("uses only system application artwork and opens the selected handler with the frozen File identity", async () => {
  render(<FileOpenWithButton {...props} />);
  const primary = screen.getByRole("button", { name: "在外部应用打开当前原件" });
  await waitFor(() => expect(primary.querySelector("img")).toHaveAttribute("src", icon));
  expect(primary).not.toHaveTextContent("外部打开");
  fireEvent.click(primary);
  expect(props.onOpen).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "选择其他应用打开当前原件" }));
  const menu = await screen.findByRole("dialog", { name: "其他应用打开" });
  const viewer = await within(menu).findByRole("button", { name: /Viewer/ });
  expect(viewer).toHaveTextContent("Viewer（默认）");
  expect(menu.querySelector("header")).toBeNull();
  expect(viewer.querySelector("img")).toHaveAttribute("src", icon);
  expect(within(menu).getByRole("button", { name: "Editor" }).querySelector("img,svg")).toBeNull();
  expect(projectFileApi.applications).toHaveBeenCalledWith(binding, object);
  fireEvent.click(viewer);
  await waitFor(() => expect(projectFileApi.openWith).toHaveBeenCalledWith(binding, object, applications[0].id));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("reports query and opening failures and permits an explicit retry", async () => {
  vi.mocked(projectFileApi.applications).mockRejectedValueOnce(new Error("无法读取系统应用"));
  render(<FileOpenWithButton {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "选择其他应用打开当前原件" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("无法读取系统应用");
  fireEvent.click(screen.getByRole("button", { name: "重新读取" }));
  const viewer = await screen.findByRole("button", { name: /Viewer/ });
  vi.mocked(projectFileApi.openWith).mockRejectedValueOnce(new Error("工作区已切换"));
  fireEvent.click(viewer);
  expect(await screen.findByRole("alert")).toHaveTextContent("工作区已切换");
  expect(screen.getByRole("dialog")).toBeVisible();
  fireEvent.click(viewer);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("drops a late application list after hiding or changing the File and Escape restores focus", async () => {
  let finish!: (value: typeof applications) => void;
  vi.mocked(projectFileApi.applications).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<FileOpenWithButton {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "选择其他应用打开当前原件" }));
  await waitFor(() => expect(projectFileApi.applications).toHaveBeenCalledOnce());
  view.rerender(<FileOpenWithButton {...props} visible={false} />);
  await act(async () => finish(applications));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(projectFileApi.openWith).not.toHaveBeenCalled();
  view.rerender(<FileOpenWithButton {...props} fileId={8} fileName="second.TXT" />);
  const trigger = screen.getByRole("button", { name: "选择其他应用打开当前原件" });
  fireEvent.click(trigger);
  await screen.findByRole("button", { name: /Viewer/ });
  expect(projectFileApi.applications).toHaveBeenCalledOnce();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
});

it("renders prefetched type artwork immediately and opens the current File with a fresh binding", async () => {
  client.setQueryData(fileApplicationOptions("/workspace", 2, 7, "first.txt").queryKey, applications);
  render(<FileOpenWithButton {...props} fileId={8} fileName="second.TXT" />);
  const primary = screen.getByRole("button", { name: "在外部应用打开当前原件" });
  expect(primary.querySelector("img")).toHaveAttribute("src", icon);
  expect(projectFileApi.applications).not.toHaveBeenCalled();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue({ ...binding, generation: "new" });
  fireEvent.click(screen.getByRole("button", { name: "选择其他应用打开当前原件" }));
  fireEvent.click(await screen.findByRole("button", { name: "Editor" }));
  await waitFor(() => expect(projectFileApi.openWith).toHaveBeenCalledWith({ ...binding, generation: "new" }, { ...object, id: "8" }, applications[1].id));
});

it("does not flash a generic application icon while a new type is loading", async () => {
  let finish!: (value: typeof applications) => void;
  vi.mocked(projectFileApi.applications).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<FileOpenWithButton {...props} />);
  const primary = screen.getByRole("button", { name: "在外部应用打开当前原件" });
  expect(primary.querySelector("svg,img")).toBeNull();
  await waitFor(() => expect(projectFileApi.applications).toHaveBeenCalledOnce());
  await act(async () => finish(applications));
  await waitFor(() => expect(primary.querySelector("img")).toHaveAttribute("src", icon));
});

it("retains cached artwork during a background handler refresh", async () => {
  client.setQueryData(fileApplicationOptions("/workspace", 2, 7, "first.txt").queryKey, applications, { updatedAt: Date.now() - 6 * 60_000 });
  let finish!: (value: typeof applications) => void;
  vi.mocked(projectFileApi.applications).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<FileOpenWithButton {...props} />);
  const primary = screen.getByRole("button", { name: "在外部应用打开当前原件" });
  expect(primary.querySelector("img")).toHaveAttribute("src", icon);
  await waitFor(() => expect(projectFileApi.applications).toHaveBeenCalledOnce());
  expect(primary.querySelector("img")).toHaveAttribute("src", icon);
  await act(async () => finish(applications));
  expect(primary.querySelector("img")).toHaveAttribute("src", icon);
});

it("keeps the default icon after choosing another app and disables both segments while opening", async () => {
  const view = render(<FileOpenWithButton {...props} />);
  const primary = screen.getByRole("button", { name: "在外部应用打开当前原件" });
  const toggle = screen.getByRole("button", { name: "选择其他应用打开当前原件" });
  await waitFor(() => expect(primary.querySelector("img")).toHaveAttribute("src", icon));
  fireEvent.click(toggle);
  fireEvent.click(await screen.findByRole("button", { name: "Editor" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(primary.querySelector("img")).toHaveAttribute("src", icon);
  view.rerender(<FileOpenWithButton {...props} opening />);
  expect(primary).toBeDisabled();
  expect(toggle).toBeDisabled();
});

it("does not query hidden files and dismisses on outside pointer down", async () => {
  const view = render(<FileOpenWithButton {...props} visible={false} />);
  expect(projectFileApi.applications).not.toHaveBeenCalled();
  view.rerender(<FileOpenWithButton {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "选择其他应用打开当前原件" }));
  await screen.findByRole("button", { name: /Viewer/ });
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});
