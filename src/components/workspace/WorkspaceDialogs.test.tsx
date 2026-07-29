import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UnlockWorkspaceSecretsDialog } from "./WorkspaceDialogs";

describe("UnlockWorkspaceSecretsDialog", () => {
  it("renders above the settings dialog layer", () => {
    render(
      <UnlockWorkspaceSecretsDialog
        open
        pending={false}
        error={null}
        password=""
        onPasswordChange={() => undefined}
        onClose={() => undefined}
        onSubmit={() => undefined}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "解锁 Workspace Secrets" }).parentElement,
    ).toHaveClass("z-[60]");
  });
});
