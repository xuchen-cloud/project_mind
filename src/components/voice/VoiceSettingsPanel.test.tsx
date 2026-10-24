import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsUpsert: vi.fn(),
  modelStatusGet: vi.fn(),
  diarizationModelStatusGet: vi.fn(),
  diarizationModelImport: vi.fn(),
  diarizationModelInstall: vi.fn(),
  diarizationModelInstallStatusGet: vi.fn(),
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
  diarizationModelInstall: mocks.diarizationModelInstall,
  diarizationModelInstallStatusGet: mocks.diarizationModelInstallStatusGet,
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
    mocks.diarizationModelInstallStatusGet.mockReset().mockResolvedValue({ phase: "idle", downloadedBytes: 0, totalBytes: 0, error: null });
    mocks.diarizationModelInstall.mockReset().mockResolvedValue({ phase: "downloading", downloadedBytes: 0, totalBytes: 100, error: null });
    mocks.diarizationModelStatusGet.mockReset().mockResolvedValue({ ready: false, detail: "说话人模型未导入" });
    mocks.diarizationModelImport.mockReset().mockImplementation(async () => {
      const ready = { ready: true, detail: "说话人模型已就绪" };
      mocks.diarizationModelStatusGet.mockResolvedValue(ready);
      return ready;
    });
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

  afterEach(() => vi.useRealTimers());

  it("keeps model files and manual downloads out of the initial speaker setup", async () => {
    renderPanel();
    const speaker = await screen.findByRole("region", { name: "本地说话人模型" });
    expect(await within(speaker).findByRole("button", { name: "下载并启用" })).toBeEnabled();
    expect(within(speaker).queryByRole("button", { name: /下载分段|下载声纹/ })).not.toBeInTheDocument();
    expect(speaker.textContent).not.toMatch(/model.onnx|SHA-256|EMBEDDING-LICENSE/);
    expect(within(speaker).getByText(/约 46 MB/)).toBeInTheDocument();
    fireEvent.click(within(speaker).getByRole("button", { name: "下载并启用" }));
    await waitFor(() => expect(mocks.diarizationModelInstall).toHaveBeenCalledOnce());
    expect(mocks.pickDirectory).not.toHaveBeenCalled();
  });

  it("polls byte progress then verification and refreshes the ready model exactly once", async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderPanel(client);
    await act(() => vi.advanceTimersByTimeAsync(10));
    mocks.diarizationModelInstall.mockResolvedValue({ phase: "downloading", downloadedBytes: 50, totalBytes: 100, error: null });
    fireEvent.click(screen.getByRole("button", { name: "下载并启用" }));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByRole("progressbar", { name: "说话人模型下载进度" })).toHaveAttribute("value", "50");
    expect(screen.getByText(/50%/)).toBeInTheDocument();
    mocks.diarizationModelInstallStatusGet.mockResolvedValue({ phase: "verifying", downloadedBytes: 100, totalBytes: 100, error: null });
    await act(() => vi.advanceTimersByTimeAsync(510));
    expect(screen.getByText("正在校验并启用…")).toBeInTheDocument();
    mocks.diarizationModelStatusGet.mockResolvedValue({ ready: true, detail: "模型已就绪" });
    mocks.diarizationModelInstallStatusGet.mockResolvedValue({ phase: "ready", downloadedBytes: 100, totalBytes: 100, error: null });
    await act(() => vi.advanceTimersByTimeAsync(510));
    expect(screen.getByText("已启用")).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["voice-diarization-model"] });
    const calls = mocks.diarizationModelInstallStatusGet.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(mocks.diarizationModelInstallStatusGet).toHaveBeenCalledTimes(calls);
    expect(mocks.diarizationModelStatusGet).toHaveBeenCalledTimes(2);
  });

  it("shows a concrete failure and only retries when requested", async () => {
    mocks.diarizationModelInstallStatusGet.mockResolvedValue({ phase: "failed", downloadedBytes: 12, totalBytes: 100, error: "网络连接中断" });
    renderPanel();
    expect(await screen.findByText("网络连接中断")).toBeInTheDocument();
    expect(mocks.diarizationModelInstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试下载" }));
    await waitFor(() => expect(mocks.diarizationModelInstall).toHaveBeenCalledOnce());
  });

  it("stops automatic polling after a status read error and allows a manual retry", async () => {
    vi.useFakeTimers();
    mocks.diarizationModelInstallStatusGet.mockResolvedValue({ phase: "downloading", downloadedBytes: 20, totalBytes: 100, error: null });
    renderPanel();
    await act(() => vi.advanceTimersByTimeAsync(10));
    mocks.diarizationModelInstallStatusGet.mockRejectedValue(new Error("读取下载状态失败"));
    await act(() => vi.advanceTimersByTimeAsync(510));
    expect(screen.getByText("Error: 读取下载状态失败")).toBeInTheDocument();
    const calls = mocks.diarizationModelInstallStatusGet.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.diarizationModelInstallStatusGet).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole("button", { name: "重试下载" }));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(mocks.diarizationModelInstall).toHaveBeenCalledOnce();
  });

  it("stops polling when closed and reads global installation progress on reopening", async () => {
    vi.useFakeTimers();
    mocks.diarizationModelInstallStatusGet.mockResolvedValue({ phase: "downloading", downloadedBytes: 20, totalBytes: 100, error: null });
    const client = new QueryClient();
    const view = render(<QueryClientProvider client={client}><VoiceSettingsPanel open /></QueryClientProvider>);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText(/20%/)).toBeInTheDocument();
    view.rerender(<QueryClientProvider client={client}><VoiceSettingsPanel open={false} /></QueryClientProvider>);
    const calls = mocks.diarizationModelInstallStatusGet.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(mocks.diarizationModelInstallStatusGet).toHaveBeenCalledTimes(calls);
    mocks.diarizationModelInstallStatusGet.mockResolvedValue({ phase: "downloading", downloadedBytes: 75, totalBytes: 100, error: null });
    view.rerender(<QueryClientProvider client={client}><VoiceSettingsPanel open /></QueryClientProvider>);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(screen.getByText(/75%/)).toBeInTheDocument();
  });

  it("does not offer another download for an already ready model package", async () => {
    mocks.diarizationModelStatusGet.mockResolvedValue({ ready: true, detail: "已就绪" });
    renderPanel();
    expect(await screen.findByText("已启用")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下载并启用" })).not.toBeInTheDocument();
    expect(mocks.diarizationModelInstall).not.toHaveBeenCalled();
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
      fireEvent.click(await screen.findByText("高级选项"));
      const button = await screen.findByRole("button", { name: "从本地导入" });
      expect(observer.getCurrentResult().data?.ready).toBe(false);
      fireEvent.click(button);
      await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: key }));
      await waitFor(() => expect(observer.getCurrentResult().data?.ready).toBe(true));
      expect(mocks.diarizationModelStatusGet).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it("imports speaker models independently of the recognition engine", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("高级选项"));
    fireEvent.click(screen.getByRole("button", { name: "从本地导入" }));
    await waitFor(() => expect(mocks.diarizationModelImport).toHaveBeenCalledWith("C:/speaker-model"));
    expect(await screen.findByText("已启用")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /说话人/ })).not.toBeInTheDocument();
  });

  it("offers a manual readiness check after install completion and can prepare again if the package is missing", async () => {
    mocks.diarizationModelInstallStatusGet.mockResolvedValue({ phase: "ready", downloadedBytes: 100, totalBytes: 100, error: null });
    mocks.diarizationModelStatusGet.mockRejectedValue(new Error("启用状态读取失败"));
    renderPanel();
    await screen.findByRole("button", { name: "重新检查" });
    expect(screen.getByText("Error: 启用状态读取失败")).toBeInTheDocument();
    expect(screen.queryByText("正在确认启用状态…")).not.toBeInTheDocument();
    expect(mocks.diarizationModelInstall).not.toHaveBeenCalled();
    mocks.diarizationModelStatusGet.mockResolvedValue({ ready: false, detail: "模型文件缺失" });
    fireEvent.click(screen.getByRole("button", { name: "重新检查" }));
    fireEvent.click(await screen.findByRole("button", { name: "重新准备" }));
    await waitFor(() => expect(mocks.diarizationModelInstall).toHaveBeenCalledOnce());
  });

  it("hides an old download error after successful offline import but keeps a new import error", async () => {
    mocks.diarizationModelInstallStatusGet.mockResolvedValue({ phase: "failed", downloadedBytes: 10, totalBytes: 100, error: "旧下载失败" });
    renderPanel();
    expect(await screen.findByText("旧下载失败")).toBeInTheDocument();
    fireEvent.click(screen.getByText("高级选项"));
    fireEvent.click(screen.getByRole("button", { name: "从本地导入" }));
    expect(await screen.findByText("已启用")).toBeInTheDocument();
    expect(screen.queryByText("旧下载失败")).not.toBeInTheDocument();
    mocks.diarizationModelImport.mockRejectedValue(new Error("新导入文件无效"));
    fireEvent.click(screen.getByRole("button", { name: "从本地导入" }));
    expect(await screen.findByText("Error: 新导入文件无效")).toBeInTheDocument();
    expect(screen.getByText("已启用")).toBeInTheDocument();
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

  it("keeps ready local recognition management collapsed until requested", async () => {
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
    expect(screen.getByRole("button", { name: "重新导入本地模型", hidden: true })).not.toBeVisible();
    expect(screen.getByRole("button", { name: "获取指定模型包", hidden: true })).not.toBeVisible();
    expect(screen.getByText(/选择包含 model.int8.onnx/)).not.toBeVisible();
    fireEvent.click(screen.getByText("本地模型管理"));
    expect(screen.getByRole("button", { name: "获取指定模型包" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新导入本地模型" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导入本地模型" })).not.toBeInTheDocument();
  });
});
