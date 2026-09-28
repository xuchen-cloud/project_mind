import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { HomeCover } from "./HomeCover";
import { WorkspaceTopBar } from "../layout/WorkspaceTopBar";
import { readHomeIdentity, writeHomeIdentity, type HomeIdentityValue } from "./homeIdentity";

vi.mock("./homeIdentity", () => ({
  readHomeIdentity: vi.fn(), writeHomeIdentity: vi.fn(), resizeHomeCover: vi.fn(),
}));
const saved: HomeIdentityValue = { cover: "forest", positionX: 24, positionY: 65, icon: "Compass" };
beforeEach(() => {
  vi.mocked(readHomeIdentity).mockReset().mockResolvedValue(saved);
  vi.mocked(writeHomeIdentity).mockReset().mockResolvedValue(undefined);
});

function renderProject() {
  return render(<>
    <WorkspaceTopBar projects={[{ id: 2, name: "Beta", rootPath: "/beta", kind: "normal", status: "active", quickNote: "", isArchived: false, createdAt: "", updatedAt: "", openTodoCount: 0 }]}
      activeProjectId={2} searchInput="" searchResults={[]} searching={false} onSearchInput={vi.fn()} onOpenProject={vi.fn()}
      onOpenWorkspace={vi.fn()} onSwitchWorkspace={vi.fn()} onOpenSettings={vi.fn()} onSearchSelect={vi.fn()} />
    <HomeCover identityKey="project:/beta" defaultIcon="Compass" canEditIcon title="Beta" />
  </>);
}

it("edits the project icon directly and updates the tab without changing its cover", async () => {
  const user = userEvent.setup();
  renderProject();
  const tab = screen.getByRole("tab", { name: "Beta" });
  await waitFor(() => expect(tab.querySelector('.lucide-compass')).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "修改项目图标" }));
  const dialog = screen.getByRole("dialog", { name: "修改项目图标" });
  expect(within(dialog).queryByText("内置封面")).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole("button", { name: "目标" }));
  vi.mocked(readHomeIdentity).mockResolvedValue({ ...saved, icon: "Target" });
  await user.click(within(dialog).getByRole("button", { name: "保存", exact: true }));
  await waitFor(() => expect(writeHomeIdentity).toHaveBeenCalledWith("project:/beta", { ...saved, icon: "Target" }));
  await waitFor(() => expect(tab.querySelector('.lucide-target')).toBeInTheDocument());
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("does not persist a cancelled icon selection", async () => {
  const user = userEvent.setup();
  renderProject();
  await user.click(screen.getByRole("button", { name: "修改项目图标" }));
  await user.click(screen.getByRole("button", { name: "目标" }));
  await user.click(screen.getByRole("button", { name: "取消" }));
  expect(writeHomeIdentity).not.toHaveBeenCalled();
  expect(screen.getByRole("tab", { name: "Beta" }).querySelector('.lucide-compass')).toBeInTheDocument();
});
