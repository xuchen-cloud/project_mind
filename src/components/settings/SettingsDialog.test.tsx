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

describe("SettingsDialog", () => {
  it("lets the user open the application update section", async () => {
    const user = userEvent.setup();

    function SettingsHarness() {
      const [section, setSection] = useState<SettingsSection>("page-width");
      return (
        <SettingsDialog
          open
          activeSection={section}
          projectId={null}
          onSectionChange={setSection}
          onUnlockAiSecrets={async () => true}
          onClose={() => undefined}
        />
      );
    }

    render(<SettingsHarness />);

    await user.click(screen.getByRole("button", { name: "应用更新" }));

    expect(await screen.findByTestId("update-settings-panel")).toBeInTheDocument();
    expect(await screen.findByText("当前版本 0.1.0")).toBeInTheDocument();
  });
});
