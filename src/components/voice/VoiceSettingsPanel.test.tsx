import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsUpsert: vi.fn(),
  modelStatusGet: vi.fn(),
  diarizationModelStatusGet: vi.fn(),
  diarizationModelImport: vi.fn(),
  pickDirectory: vi.fn(),
  aiSettingsGet: vi.fn(),
  profileTest: vi.fn(),
  pushToast: vi.fn(),
}));

vi.mock("../../services/voiceApi", () => ({ voiceApi: {
  settingsGet: mocks.settingsGet,
  settingsUpsert: mocks.settingsUpsert,
  modelStatusGet: mocks.modelStatusGet,
  diarizationModelStatusGet: mocks.diarizationModelStatusGet,
  diarizationModelImport: mocks.diarizationModelImport,
  profileTest: mocks.profileTest,
} }));
vi.mock("../../services/projectMindApi", () => ({ projectMindApi: { aiSettingsGet: mocks.aiSettingsGet } }));
vi.mock("../../services/desktopApi", () => ({ desktopApi: { pickDirectory: mocks.pickDirectory, openExternalUrl: vi.fn() } }));
vi.mock("../../state/feedback-store", () => ({ useFeedbackStore: () => ({ pushToast: mocks.pushToast }) }));

import { VoiceSettingsPanel } from "./VoiceSettingsPanel";

function renderPanel(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(<QueryClientProvider client={client}><VoiceSettingsPanel open /></QueryClientProvider>);
}

describe("VoiceSettingsPanel", () => {
  beforeEach(() => {
    mocks.settingsGet.mockReset();
    mocks.diarizationModelStatusGet.mockReset().mockResolvedValue({ ready: false, detail: "说话人模型未导入" });
    mocks.diarizationModelImport.mockReset().mockResolvedValue({ ready: true, detail: "说话人模型已就绪" });
    mocks.pickDirectory.mockReset().mockResolvedValue("C:/speaker-model");
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

  it("invalidates and refetches an already mounted recording's missing speaker model cache after import", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const key = ["voice-diarization-model"];
    client.setQueryData(key, { ready: false, detail: "说话人模型未导入" });
    const observer = new QueryObserver(client, { queryKey: key, queryFn: () => mocks.diarizationModelStatusGet() });
    const unsubscribe = observer.subscribe(() => {});
    const invalidate = vi.spyOn(client, "invalidateQueries");
    mocks.diarizationModelImport.mockImplementation(async () => {
      const ready = { ready: true, detail: "说话人模型已就绪" };
      mocks.diarizationModelStatusGet.mockResolvedValue(ready);
      return ready;
    });
    try {
      renderPanel(client);
      const button = await screen.findByRole("button", { name: "导入说话人模型" });
      expect(observer.getCurrentResult().data?.ready).toBe(false);
      fireEvent.click(button);
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: key }));
      await waitFor(() => expect(observer.getCurrentResult().data?.ready).toBe(true));
      expect(mocks.diarizationModelStatusGet).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });

  it("imports speaker models independently of the recognition engine", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "导入说话人模型" }));
    await waitFor(() => expect(mocks.diarizationModelImport).toHaveBeenCalledWith("C:/speaker-model"));
    expect(await screen.findByText("说话人模型已就绪")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /说话人/ })).not.toBeInTheDocument();
  });

  it("tests Paraformer with the selected saved credential without exposing its key", async () => {
    renderPanel();
    const select = await screen.findByRole("combobox", { name: "密钥配置" });
    fireEvent.change(select, { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "测试 Paraformer 连接" }));
    expect(mocks.profileTest).toHaveBeenCalledWith({
      endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
      credentialProfileId: 7,
    });
  });

  it("saves the cloud interim caption switch", async () => {
    renderPanel();
    const toggle = await screen.findByRole("checkbox", { name: "实时临时字幕" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(mocks.settingsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ livePreviewEnabled: true }),
    ));
  });

  it("saves the text profile for minutes and AI title", async () => {
    renderPanel();
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
    renderPanel();
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
    renderPanel();
    expect(await screen.findByText("本地模型已就绪，无需再次导入")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新导入本地模型" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导入本地模型" })).not.toBeInTheDocument();
  });
});
