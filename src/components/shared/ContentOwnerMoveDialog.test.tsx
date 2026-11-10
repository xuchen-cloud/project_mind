import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { queryKeys } from "../../lib/queryKeys";
import { ContentOwnerMoveDialog } from "./ContentOwnerMoveDialog";

const api = vi.hoisted(() => ({ binding: vi.fn(), projects: vi.fn(), move: vi.fn() }));
vi.mock("../../services/recordDocumentApi", () => ({ recordDocumentApi: { bindingGet: api.binding } }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { projectsList: api.projects } }));
vi.mock("../../services/contentOwnerMoveApi", () => ({ moveContentOwner: api.move }));
const binding = { workspaceId: "w1", generation: "g1" };
const projects = [{ id: 7, name: "源项目", isArchived: false }, { id: 8, name: "目标项目", isArchived: false }, { id: 9, name: "归档项目", isArchived: true }];
const source = { workspaceRoot: "/workspace", sourceProjectId: 7, object: { kind: "record" as const, id: 11 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup(props: Omit<Parameters<typeof ContentOwnerMoveDialog>[0], "onClose"> = source) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const view = render(<ContentOwnerMoveDialog {...props} onClose={onClose} />, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  return { ...view, client, onClose };
}
async function submitTarget() {
  fireEvent.click(await screen.findByRole("radio", { name: /目标项目/ }));
  fireEvent.click(screen.getByRole("button", { name: "移动" }));
}
beforeEach(() => {
  vi.resetAllMocks();
  api.binding.mockResolvedValue(binding);
  api.projects.mockResolvedValue(projects);
  api.move.mockResolvedValue(undefined);
});

it("loads real destinations, disables the current owner and archives, and waits for loading", async () => {
  const pending = deferred<typeof projects>();
  api.projects.mockReturnValue(pending.promise);
  setup();
  expect(screen.getByRole("button", { name: "移动" })).toBeDisabled();
  await waitFor(() => expect(api.projects).toHaveBeenCalledWith({ includeArchived: true }));
  await act(async () => pending.resolve(projects));
  expect(await screen.findByRole("radio", { name: /源项目/ })).toBeDisabled();
  expect(screen.getByRole("radio", { name: /归档项目/ })).toBeDisabled();
  expect(screen.getByRole("radio", { name: /工作区根级/ })).toBeEnabled();
  expect(screen.getByRole("radio", { name: /目标项目/ })).toBeEnabled();
  expect(api.move).not.toHaveBeenCalled();
});

it.each(["binding", "projects"] as const)("allows retry after a %s load failure without reporting success", async boundary => {
  api[boundary].mockRejectedValueOnce(new Error("目标读取失败"));
  const { onClose } = setup();
  expect(await screen.findByRole("alert")).toHaveTextContent("目标读取失败");
  expect(api.move).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "重新加载移动目标" }));
  expect(await screen.findByRole("radio", { name: /目标项目/ })).toBeEnabled();
});

it("keeps a failed move open and retries the same frozen service input before invalidating both pages", async () => {
  api.move.mockRejectedValueOnce(new Error("目标内容保存失败"));
  const { client, onClose } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await submitTarget();
  expect(await screen.findByRole("alert")).toHaveTextContent("目标内容保存失败");
  expect(onClose).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "移动" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(api.move).toHaveBeenNthCalledWith(1, { ...source, binding, destinationProjectId: 8 });
  expect(api.move).toHaveBeenNthCalledWith(2, { ...source, binding, destinationProjectId: 8 });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.projectPage(7) });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.projectPage(8) });
});

it("moves a File to Workspace and invalidates its retained versions after confirmed success", async () => {
  const props = { ...source, object: { kind: "file" as const, id: 21 } };
  const { client, onClose } = setup(props);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await screen.findByRole("radio", { name: /目标项目/ });
  fireEvent.click(screen.getByRole("radio", { name: /工作区根级/ }));
  fireEvent.click(screen.getByRole("button", { name: "移动" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(api.move).toHaveBeenCalledWith({ ...props, binding, destinationProjectId: null });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.workspacePage });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.projectPage(7) });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.documentVersions(21) });
});

it("does not let a late destination list replace the list for another Workspace", async () => {
  const oldList = deferred<typeof projects>();
  api.projects.mockReturnValueOnce(oldList.promise);
  const { rerender, onClose } = setup();
  await waitFor(() => expect(api.projects).toHaveBeenCalledOnce());
  api.binding.mockResolvedValue({ workspaceId: "w2", generation: "g2" });
  api.projects.mockResolvedValue([{ id: 8, name: "新工作区项目" }]);
  rerender(<ContentOwnerMoveDialog {...source} workspaceRoot="/other" onClose={onClose} />);
  expect(await screen.findByRole("radio", { name: /新工作区项目/ })).toBeEnabled();
  await act(async () => oldList.resolve(projects));
  expect(screen.queryByRole("radio", { name: /目标项目/ })).not.toBeInTheDocument();
  expect(onClose).not.toHaveBeenCalled();
});

it.each(["workspace", "generation", "owner", "kind", "id"])("ignores old move completion after the %s identity changes", async change => {
  const pending = deferred<void>();
  api.move.mockReturnValueOnce(pending.promise);
  const { client, rerender, onClose } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await submitTarget();
  await waitFor(() => expect(api.move).toHaveBeenCalledOnce());
  const next = { ...source, object: { ...source.object } as { kind: "record" | "file"; id: number } };
  if (change === "workspace") next.workspaceRoot = "/other";
  if (change === "owner") next.sourceProjectId = 8;
  if (change === "kind") next.object.kind = "file";
  if (change === "id") next.object.id = 12;
  if (change === "generation") await act(async () => { client.setQueryData(queryKeys.projectContentBinding(source.workspaceRoot), { ...binding, generation: "g2" }); });
  else rerender(<ContentOwnerMoveDialog {...next} onClose={onClose} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "取消" })).toBeEnabled());
  await act(async () => pending.resolve());
  expect(onClose).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("never asks native for a binding or destinations when the real Workspace root is absent", () => {
  setup({ ...source, workspaceRoot: "" });
  expect(api.binding).not.toHaveBeenCalled();
  expect(api.projects).not.toHaveBeenCalled();
  expect(api.move).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "移动" })).toBeDisabled();
});
