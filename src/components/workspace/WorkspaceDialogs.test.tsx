import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const buildMode = vi.hoisted(() => ({ debug: true }));
vi.mock("../../lib/build-mode", () => ({ get isDebugBuild() { return buildMode.debug; } }));
import { CreateWorkspaceDialog, UnlockWorkspaceSecretsDialog } from "./WorkspaceDialogs";
afterEach(() => { buildMode.debug = true; vi.unstubAllEnvs(); });
describe("Workspace password modes", () => {
  it.each([{ label: "Vite dev", debug: true }, { label: "native debug / production frontend", debug: true }, { label: "release", debug: false }])("shows a new-workspace password only outside DEV ($label)", ({ debug: dev }) => {
    buildMode.debug = dev;
    const submit = vi.fn();
    render(<CreateWorkspaceDialog open rootPath="/workspace" password="" pending={false} error={null}
      onRootPathChange={() => {}} onPasswordChange={() => {}} onPickRoot={() => {}} onClose={() => {}} onSubmit={submit} />);
    if (dev) { expect(screen.queryByPlaceholderText("用于加密保存的 AI API Key")).toBeNull(); expect(screen.getByText("开发模式下无需设置 Workspace 密码。")).toBeVisible(); }
    else expect(screen.getByPlaceholderText("用于加密保存的 AI API Key")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "创建 Workspace" })); expect(submit).toHaveBeenCalledOnce();
  });
  it.each([{ label: "Vite dev", debug: true }, { label: "native debug / production frontend", debug: true }, { label: "release", debug: false }])("keeps first unlock above settings with focus/error feedback ($label)", ({ debug: dev }) => {
    buildMode.debug = dev;
    render(<UnlockWorkspaceSecretsDialog open pending={false} error="密码不正确" password=""
      onPasswordChange={() => {}} onClose={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole("dialog", { name: dev ? "初始化 Workspace Secrets" : "解锁 Workspace Secrets" }).parentElement).toHaveClass("z-[60]");
    expect(screen.getByPlaceholderText("输入密码后继续")).toHaveFocus(); expect(screen.getByRole("alert")).toHaveTextContent("密码不正确");
    if (dev) expect(screen.getByText(/旧加密工作区尚未初始化自动解锁/u)).toBeVisible();
    else expect(screen.getByText("输入当前 workspace 密码后，可以继续使用已保存的 AI API Key。")).toBeVisible();
  });
  it("shows initialization pending state without hiding errors", () => {
    buildMode.debug = true;
    render(<UnlockWorkspaceSecretsDialog open pending error={null} password=""
      onPasswordChange={() => {}} onClose={() => {}} onSubmit={() => {}} />);
    expect(screen.getByRole("button", { name: "初始化中..." })).toBeDisabled();
  });
});
