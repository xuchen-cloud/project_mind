import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AppUpdaterClient } from "../../services/appUpdater";
import { RecordSaveCoordinator } from "../../lib/record-save-coordinator";
import { RecordSaveCoordinatorProvider } from "../../lib/record-save-runtime";
import { UpdateSettingsPanel } from "./UpdateSettingsPanel";

describe("UpdateSettingsPanel", () => {
  it("shows an available Beta update after the user checks for updates", async () => {
    const user = userEvent.setup();
    const updater: AppUpdaterClient = {
      currentVersion: vi.fn(async () => "0.1.0"),
      check: vi.fn(async () => ({
        version: "0.2.0-beta.1",
        notes: "修复 Windows 安装并增加 Workspace 升级保护。",
      })),
      install: vi.fn(),
    };

    render(<UpdateSettingsPanel updater={updater} />);

    expect(await screen.findByText("当前版本 0.1.0")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "检查更新" }));

    expect(await screen.findByText("发现新版本 0.2.0-beta.1")).toBeInTheDocument();
    expect(
      screen.getByText("修复 Windows 安装并增加 Workspace 升级保护。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载并安装" })).toBeEnabled();
  });

  it("installs the selected update and tells the user the app will restart", async () => {
    const user = userEvent.setup();
    const update = {
      version: "0.2.0-beta.1",
      notes: "Beta update",
    };
    const updater: AppUpdaterClient = {
      currentVersion: vi.fn(async () => "0.1.0"),
      check: vi.fn(async () => update),
      install: vi.fn(async () => undefined),
    };

    render(<UpdateSettingsPanel updater={updater} />);

    await user.click(await screen.findByRole("button", { name: "检查更新" }));
    await user.click(await screen.findByRole("button", { name: "下载并安装" }));

    expect(updater.install).toHaveBeenCalledWith(update);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "更新已安装，正在重新启动…",
    );
  });

  it("flushes pending Record saves before installing an update", async () => {
    const user = userEvent.setup();
    let finishSave!: () => void;
    const pendingSave = new Promise<{ updatedAt: string }>((resolve) => {
      finishSave = () => resolve({ updatedAt: "saved" });
    });
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(() => pendingSave) },
    });
    coordinator.submit({
      workspaceKey: "/tmp/workspace",
      projectId: 1,
      noteId: 7,
      activityId: null,
      title: "Record",
      tagIds: [],
      defaultCodeLanguage: null,
      committedContent: { html: "<p>pending</p>", text: "pending", markdown: "pending" },
    });
    const update = { version: "0.2.0-beta.1", notes: null };
    const updater: AppUpdaterClient = {
      currentVersion: vi.fn(async () => "0.1.0"),
      check: vi.fn(async () => update),
      install: vi.fn(async () => undefined),
    };
    render(
      <RecordSaveCoordinatorProvider coordinator={coordinator}>
        <UpdateSettingsPanel updater={updater} />
      </RecordSaveCoordinatorProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "检查更新" }));
    await user.click(await screen.findByRole("button", { name: "下载并安装" }));
    expect(updater.install).not.toHaveBeenCalled();

    finishSave();
    expect(await screen.findByRole("status")).toHaveTextContent("正在重新启动");
    expect(updater.install).toHaveBeenCalledWith(update);
  });

  it("does not install an update when the Record save barrier fails", async () => {
    const user = userEvent.setup();
    const coordinator = new RecordSaveCoordinator({
      workspaceKey: "/tmp/workspace",
      adapter: { persist: vi.fn(async () => { throw new Error("disk busy"); }) },
    });
    coordinator.submit({
      workspaceKey: "/tmp/workspace",
      projectId: 1,
      noteId: 7,
      activityId: null,
      title: "Record",
      tagIds: [],
      defaultCodeLanguage: null,
      committedContent: { html: "<p>pending</p>", text: "pending", markdown: "pending" },
    });
    const update = { version: "0.2.0-beta.1", notes: null };
    const updater: AppUpdaterClient = {
      currentVersion: vi.fn(async () => "0.1.0"),
      check: vi.fn(async () => update),
      install: vi.fn(async () => undefined),
    };
    render(
      <RecordSaveCoordinatorProvider coordinator={coordinator}>
        <UpdateSettingsPanel updater={updater} />
      </RecordSaveCoordinatorProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "检查更新" }));
    await user.click(await screen.findByRole("button", { name: "下载并安装" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk busy");
    expect(updater.install).not.toHaveBeenCalled();
  });

  it("confirms when the installed version is already current", async () => {
    const user = userEvent.setup();
    const updater: AppUpdaterClient = {
      currentVersion: vi.fn(async () => "0.1.0"),
      check: vi.fn(async () => null),
      install: vi.fn(),
    };

    render(<UpdateSettingsPanel updater={updater} />);

    await user.click(await screen.findByRole("button", { name: "检查更新" }));

    expect(await screen.findByRole("status")).toHaveTextContent("当前已是最新版本");
  });

  it("keeps update failures visible and retryable", async () => {
    const user = userEvent.setup();
    const updater: AppUpdaterClient = {
      currentVersion: vi.fn(async () => "0.1.0"),
      check: vi.fn(async () => {
        throw new Error("无法读取 Beta 更新清单");
      }),
      install: vi.fn(),
    };

    render(<UpdateSettingsPanel updater={updater} />);

    await user.click(await screen.findByRole("button", { name: "检查更新" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取 Beta 更新清单");
    expect(screen.getByRole("button", { name: "重新检查" })).toBeEnabled();
  });

  it("keeps current-version failures visible and retryable", async () => {
    const user = userEvent.setup();
    const currentVersion = vi
      .fn<AppUpdaterClient["currentVersion"]>()
      .mockRejectedValueOnce(new Error("无法读取当前版本"))
      .mockResolvedValueOnce("0.1.0");
    const updater: AppUpdaterClient = {
      currentVersion,
      check: vi.fn(async () => null),
      install: vi.fn(),
    };

    render(<UpdateSettingsPanel updater={updater} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("无法读取当前版本");
    await user.click(screen.getByRole("button", { name: "重新检查" }));

    expect(await screen.findByText("当前版本 0.1.0")).toBeInTheDocument();
    expect(currentVersion).toHaveBeenCalledTimes(2);
  });
});
