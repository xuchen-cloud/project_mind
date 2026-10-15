import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentScopeSettings } from "../../lib/agent-types";
import { subscribeAgentSettings } from "../../lib/agent-workspace-settings";

const api = vi.hoisted(() => ({ statusGet: vi.fn(), settingsGet: vi.fn(), settingsUpdate: vi.fn(), aiSettingsGet: vi.fn(), openSettings: vi.fn() }));
vi.mock("../../services/agentApi", async original => ({ ...await original<typeof import("../../services/agentApi")>(), agentApi: api }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { aiSettingsGet: api.aiSettingsGet } }));
vi.mock("../../state/ui-store", () => ({ useUiStore: (selector: (state: { openSettings: typeof api.openSettings }) => unknown) => selector({ openSettings: api.openSettings }) }));
import { AgentSettingsPanel } from "./AgentSettingsPanel";

const binding = { workspaceId: "workspace", generation: "one" };
const settings: AgentScopeSettings = { scope: { kind: "workspace" }, enabled: false, revision: 0,
  goalRecordId: null, pinnedRefs: [], summaryPolicy: "on_success", overviewIntervalHours: 24,
  overviewLocalTime: "03:00", overviewTimezone: "UTC", executionMode: "review" };

beforeEach(() => {
  vi.clearAllMocks();
  api.statusGet.mockResolvedValue({ binding, runtimeAvailable: true, bridgeAvailable: false, capabilities: [] });
  api.settingsGet.mockResolvedValue(settings);
  api.settingsUpdate.mockImplementation(async (_binding, data) => ({ ...data.settings, revision: data.expectedRevision + 1 }));
  api.aiSettingsGet.mockResolvedValue({ profiles: [], bindings: [], aiSecretsUnlocked: true });
});
async function ready() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><AgentSettingsPanel open /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "启用工作区助手" })).toBeEnabled());
  return view;
}

it("saves workspace controls with a revision baseline and publishes them to open conversations", async () => {
  const onSaved = vi.fn(); const stop = subscribeAgentSettings(onSaved);
  const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
  const timezone = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...resolvedOptions.call(this), timeZone: "Asia/Shanghai" };
  });
  try {
    await ready();
    expect(api.settingsGet).toHaveBeenCalledWith(binding, { kind: "workspace" });
    expect(screen.queryByRole("button", { name: "验证工具能力" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "启用工作区助手" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(binding, { ...settings, enabled: true, overviewTimezone: "Asia/Shanghai", revision: 1 }));
    expect(api.settingsUpdate).toHaveBeenCalledWith(binding, { settings: { ...settings, enabled: true, overviewTimezone: "Asia/Shanghai" }, expectedRevision: 0 });
    fireEvent.change(screen.getByRole("combobox", { name: "执行模式" }), { target: { value: "read_only" } });
    await waitFor(() => expect(api.settingsUpdate).toHaveBeenLastCalledWith(binding, { settings: { ...settings, enabled: true, overviewTimezone: "Asia/Shanghai", executionMode: "read_only", revision: 1 }, expectedRevision: 1 }));
  } finally { stop(); timezone.mockRestore(); }
});

it("keeps a rejected settings change out of other conversations and retains the saved mode", async () => {
  api.settingsGet.mockResolvedValue({ ...settings, enabled: true, revision: 2 });
  api.settingsUpdate.mockRejectedValueOnce({ code: "REVISION_CONFLICT" });
  const onSaved = vi.fn(); const stop = subscribeAgentSettings(onSaved);
  try {
    await ready();
    fireEvent.change(screen.getByRole("combobox", { name: "执行模式" }), { target: { value: "collaborate" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("助手设置已变化");
    expect(screen.getByRole("combobox", { name: "执行模式" })).toHaveValue("review");
    expect(onSaved).not.toHaveBeenCalled();
  } finally { stop(); }
});

it("moves schedule persistence to workspace settings and keeps an existing UTC choice", async () => {
  api.settingsGet.mockResolvedValue({ ...settings, revision: 2 });
  await ready();
  fireEvent.change(screen.getByRole("combobox", { name: "维护频率" }), { target: { value: "48" } });
  await userEvent.click(screen.getByRole("button", { name: "保存维护设置" }));
  expect(api.settingsUpdate).toHaveBeenCalledWith(binding, { settings: { ...settings, revision: 2, overviewIntervalHours: 48 }, expectedRevision: 2 });
  expect(await screen.findByText("维护设置已保存")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "模型设置" }));
  expect(api.openSettings).toHaveBeenCalledWith("ai-models");
});
