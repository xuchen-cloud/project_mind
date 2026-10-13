import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import { FileOpenWithButton } from "./FileOpenWithButton";

vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: vi.fn() } }));
vi.mock("../../services/projectFileApi", () => ({ projectFileApi: { applications: vi.fn(), openWith: vi.fn() } }));
const binding = { workspaceId: "w", generation: "g" };
const object = { workspaceId: "w", scope: { kind: "project" as const, projectId: 2 }, kind: "file" as const, id: "7" };
const props = { workspaceRoot: "/workspace", projectId: 2, fileId: 7, visible: true };
const icon = "data:image/png;base64,iVBORw0KGgo=";
const applications = [{ id: "/Applications/Viewer.app", name: "Viewer", icon, isDefault: true }, { id: "/Applications/Editor.app", name: "Editor", icon: null, isDefault: false }];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(recordDocumentApi.bindingGet).mockResolvedValue(binding);
  vi.mocked(projectFileApi.applications).mockResolvedValue(applications);
});

it("uses only system application artwork and opens the selected handler with the frozen File identity", async () => {
  render(<FileOpenWithButton {...props} />);
  expect(projectFileApi.applications).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "选择其他应用打开当前原件" }));
  const menu = await screen.findByRole("dialog", { name: "其他应用打开" });
  const viewer = await within(menu).findByRole("button", { name: /Viewer/ });
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
  view.rerender(<FileOpenWithButton {...props} fileId={8} />);
  const trigger = screen.getByRole("button", { name: "选择其他应用打开当前原件" });
  fireEvent.click(trigger);
  await screen.findByRole("button", { name: /Viewer/ });
  expect(projectFileApi.applications).toHaveBeenLastCalledWith(binding, { ...object, id: "8" });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(trigger).toHaveFocus();
});
