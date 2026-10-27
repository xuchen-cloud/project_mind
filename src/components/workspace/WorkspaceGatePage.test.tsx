import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../lib/types";
import { WorkspaceGatePage } from "./WorkspaceGatePage";

const recent: WorkspaceSummary = { rootPath: "/work", metadataPath: "/work/.mind", displayName: "我的 Workspace", createdAt: "2026-10-28" };
it("keeps open/create controls usable while the initial status request is pending", async () => {
  let resolve!: (values: WorkspaceSummary[]) => void;
  const pending = new Promise<WorkspaceSummary[]>(done => { resolve = done; });
  const open = vi.fn(), create = vi.fn(), openRecent = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Gate() {
    const status = useQuery({ queryKey: ["workspace-status"], queryFn: () => pending });
    return <WorkspaceGatePage loading={status.isPending} recentWorkspaces={status.data ?? []} onOpenExisting={open} onCreateWorkspace={create} onOpenRecent={openRecent} />;
  }
  render(<QueryClientProvider client={client}><Gate /></QueryClientProvider>);
  expect(screen.getByRole("heading", { name: "打开你的 Workspace" })).toBeVisible();
  const loading = screen.getByRole("status");
  expect(loading.closest("aside")).not.toBeNull();
  expect(screen.queryByText("还没有最近使用的 Workspace。")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "打开已有 Workspace" }));
  fireEvent.click(screen.getByRole("button", { name: "新建 Workspace" }));
  expect(open).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
  await act(async () => resolve([recent]));
  fireEvent.click(await screen.findByRole("button", { name: /我的 Workspace/ }));
  expect(openRecent).toHaveBeenCalledExactlyOnceWith("/work");
  expect(screen.queryByRole("status")).toBeNull();
});

it("retains known recent entries during refresh and shows errors locally", () => {
  const openRecent = vi.fn();
  const props = { loading: true, recentWorkspaces: [recent], onOpenExisting: vi.fn(), onCreateWorkspace: vi.fn(), onOpenRecent: openRecent };
  const view = render(<WorkspaceGatePage {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /我的 Workspace/ }));
  expect(openRecent).toHaveBeenCalledExactlyOnceWith("/work");
  view.rerender(<WorkspaceGatePage {...props} loading={false} error="读取最近列表失败" />);
  expect(screen.getByRole("alert")).toHaveTextContent("读取最近列表失败");
  expect(screen.getByRole("alert").closest("aside")).not.toBeNull();
  expect(screen.getByRole("button", { name: "打开已有 Workspace" })).toBeEnabled();
  expect(screen.getByRole("button", { name: /我的 Workspace/ })).toBeEnabled();
});

it("only shows an empty recent state after loading finishes without error", () => {
  const props = { loading: false, recentWorkspaces: [], onOpenExisting: vi.fn(), onCreateWorkspace: vi.fn(), onOpenRecent: vi.fn() };
  const view = render(<WorkspaceGatePage {...props} />);
  expect(screen.getByText("还没有最近使用的 Workspace。")).toBeVisible();
  view.rerender(<WorkspaceGatePage {...props} error="读取失败" />);
  expect(screen.queryByText("还没有最近使用的 Workspace。")).toBeNull();
});
