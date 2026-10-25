import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateWorkspaceDialog } from "./WorkspaceDialogs";

describe("CreateWorkspaceDialog", () => {
  it("creates a workspace from its directory without a password", () => {
    const submit = vi.fn();
    render(<CreateWorkspaceDialog open rootPath="/workspace" pending={false} error={null}
      onRootPathChange={() => {}} onPickRoot={() => {}} onClose={() => {}} onSubmit={submit} />);
    expect(screen.queryByText(/密码/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "创建 Workspace" }));
    expect(submit).toHaveBeenCalledOnce();
  });
});
