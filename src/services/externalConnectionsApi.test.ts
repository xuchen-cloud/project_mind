import { expect, it, vi } from "vitest";
import { callAgentCommand } from "./agentApi";
import { externalConnectionsApi } from "./externalConnectionsApi";

vi.mock("./agentApi", () => ({ callAgentCommand: vi.fn() }));

it("sends local CLI lifecycle requests with unified request identity", async () => {
  const returned = { enabled: false, cliInstallation: { installed: true } };
  vi.mocked(callAgentCommand).mockResolvedValue(returned);
  await expect(externalConnectionsApi.installCli("install-id")).resolves.toBe(returned);
  await expect(externalConnectionsApi.uninstallCli("uninstall-id")).resolves.toBe(returned);
  expect(callAgentCommand).toHaveBeenNthCalledWith(1, "agent_cli_install", "install-id", { requestId: "install-id" });
  expect(callAgentCommand).toHaveBeenNthCalledWith(2, "agent_cli_uninstall", "uninstall-id", { requestId: "uninstall-id" });
});
