import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SettingsSection } from "../../state/ui-store";
import { SettingsDialog } from "./SettingsDialog";

const { mockCurrentVersion } = vi.hoisted(() => ({
  mockCurrentVersion: vi.fn(async () => "0.1.0"),
}));

vi.mock("../../services/appUpdater", () => ({
  tauriAppUpdater: {
    currentVersion: mockCurrentVersion,
    check: vi.fn(async () => null),
    install: vi.fn(),
  },
}));
vi.mock("./DshSettingsPanel", () => ({ DshSettingsPanel: ({ open }: { open: boolean }) => <p data-testid="dsh-settings-panel">{open ? "项目 DSH 设置" : "已关闭"}</p> }));

describe("SettingsDialog", () => {
  it("offers a separate DSH settings section", async () => {
    function Harness() {
      const [section, setSection] = useState<SettingsSection>("page-width");
      return <SettingsDialog open activeSection={section} onSectionChange={setSection} onUnlockAiSecrets={async () => true} onClose={() => {}} />;
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "DSH 助手", exact: true }));
    expect(await screen.findByTestId("dsh-settings-panel")).toHaveTextContent("项目 DSH 设置");
  });
  it("lets the user open the application update section", async () => {
    const user = userEvent.setup();

    function SettingsHarness() {
      const [section, setSection] = useState<SettingsSection>("page-width");
      return (
        <SettingsDialog
          open
          activeSection={section}
          onSectionChange={setSection}
          onUnlockAiSecrets={async () => true}
          onClose={() => undefined}
        />
      );
    }

    render(<SettingsHarness />);

    expect(screen.queryByRole("button", { name: /项目标签|Workspace 标签/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "应用更新" }));

    expect(await screen.findByTestId("update-settings-panel")).toBeInTheDocument();
    expect(await screen.findByText("当前版本 0.1.0")).toBeInTheDocument();
  });
});
