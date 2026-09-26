import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsUpsert: vi.fn(),
  modelStatusGet: vi.fn(),
  aiSettingsGet: vi.fn(),
  profileTest: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("../../services/voiceApi", () => ({ voiceApi: {
  settingsGet: mocks.settingsGet,
  settingsUpsert: mocks.settingsUpsert,
  modelStatusGet: mocks.modelStatusGet,
  profileTest: mocks.profileTest,
} }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { aiSettingsGet: mocks.aiSettingsGet } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { pickDirectory: vi.fn(), openExternalUrl: vi.fn() } }));
vi.mock("../../state/feedback-store", () => ({ useFeedbackStore: () => ({ pushToast: mocks.pushToast }) }));

import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

describe("VoiceSettingsPanel", () => {
  beforeEach(() => {
    mocks.settingsGet.mockReset();
    mocks.settingsUpsert.mockReset().mockResolvedValue(undefined);
    mocks.modelStatusGet.mockReset();
    mocks.aiSettingsGet.mockReset();
    mocks.profileTest.mockReset();
    mocks.pushToast.mockReset();
    mocks.settingsGet.mockResolvedValue({
      speechProfile: { kind: "paraformer", endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference", model: "paraformer-realtime-v2", credentialProfileId: null },
      livePreviewEnabled: false, textProfileId: null, translationProfileId: null, contextEnabled: false, captionLines: 4,
    });
    mocks.modelStatusGet.mockResolvedValue({ packageId: "sensevoice-small-int8-2024-07-17", ready: false, detail: "模型未就绪" });
    mocks.aiSettingsGet.mockResolvedValue({ profiles: [{ id: 7, name: "DashScope", enabled: true, hasStoredKey: true, apiKeyLast4: "1234", supportsText: true, defaultModel: "qwen-plus" }] });
    mocks.profileTest.mockResolvedValue(undefined);
  });

  it("tests Paraformer with the selected saved credential without exposing its key", async () => {
    render(<VoiceSettingsPanel open />);
    const select = await screen.findByRole("combobox", { name: "密钥配置" });
    fireEvent.change(select, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 Paraformer 连接" }));
    expect(mocks.profileTest).toHaveBeenCalledWith({
      endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      credentialProfileId: 7,
    });
  });

  it("saves the cloud interim caption switch", async () => {
    render(<VoiceSettingsPanel open />);
    const toggle = await screen.findByRole("checkbox", { name: "实时临时字幕" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ livePreviewEnabled: true }),
    ));
  });

  it("saves the text profile for minutes and AI title", async () => {
    render(<VoiceSettingsPanel open />);
    const select = await screen.findByRole("combobox", { name: "会议纪要和 AI 标题模型" });
    fireEvent.change(select, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(mocks.settingsUpsert).toHaveBeenCalledWith(expect.objectContaining({ textProfileId: 7 })));
  });

  it("saves the local provisional caption switch separately from final recognition", async () => {
    mocks.settingsGet.mockResolvedValue({
      speechProfile: { kind: "sense_voice_onnx", modelPackageId: "sensevoice-small-int8-2024-07-17" },
      livePreviewEnabled: false,
      textProfileId: null, translationProfileId: null, contextEnabled: false, captionLines: 4,
    });
    render(<VoiceSettingsPanel open />);
    const toggle = await screen.findByRole("checkbox", { name: /实时临时字幕/ });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ livePreviewEnabled: true }),
    ));
  });

  it("shows an imported local model as ready after reopening settings", async () => {
    mocks.settingsGet.mockResolvedValue({
      speechProfile: { kind: "sense_voice_onnx", modelPackageId: "sensevoice-small-int8-2024-07-17" },
      livePreviewEnabled: false,
      textProfileId: null, translationProfileId: null, contextEnabled: false, captionLines: 4,
    });
    mocks.modelStatusGet.mockResolvedValue({
      packageId: "sensevoice-small-int8-2024-07-17", ready: true,
      detail: "本地模型已就绪，无需再次导入",
    });
    render(<VoiceSettingsPanel open />);
    expect(await screen.findByText("本地模型已就绪，无需再次导入")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新导入本地模型" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导入本地模型" })).not.toBeInTheDocument();
  });
});
