import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { SpeechProfile, VoiceModelPackageStatus, VoiceSettings } from "../../lib/voice-types";
import type { AiProviderProfileRecord } from "../../lib/types";
import { desktopApi } from "../../services/desktopApi";
import { projectMindApi } from "../../services/projectMindApi";
import { voiceApi } from "../../services/voiceApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { Button, TextField } from "../../ui/components";

const DEFAULT_SETTINGS: VoiceSettings = {
  speechProfile: null,
  livePreviewEnabled: false,
  textProfileId: null,
  translationProfileId: null,
  contextEnabled: false,
  captionLines: 4,
};

export function VoiceSettingsPanel({ open }: { open: boolean }) {
  const queryClient = useQueryClient();
  const { pushToast } = useFeedbackStore();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [modelStatus, setModelStatus] = useState<VoiceModelPackageStatus | null>(null);
  const speakerModelQuery = useQuery({
    queryKey: ["voice-diarization-model"],
    queryFn: () => voiceApi.diarizationModelStatusGet(),
    enabled: open,
    retry: false,
  });
  const speakerModelStatus = speakerModelQuery.data;
  const installKey = ["voice-diarization-model-install"];
  const installQuery = useQuery({
    queryKey: installKey,
    queryFn: () => voiceApi.diarizationModelInstallStatusGet(),
    enabled: open,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    refetchInterval: (query) => open && !query.state.error && ["downloading", "verifying"].includes(query.state.data?.phase ?? "") ? 500 : false,
    retry: false,
  });
  const [startingInstall, setStartingInstall] = useState(false);
  const installBusy = startingInstall || !installQuery.isError && ["downloading", "verifying"].includes(installQuery.data?.phase ?? "");
  const handledInstallReady = useRef(false);
  useEffect(() => {
    if (installQuery.data?.phase !== "ready") { handledInstallReady.current = false; return; }
    if (!open || handledInstallReady.current) return;
    handledInstallReady.current = true;
    void queryClient.invalidateQueries({ queryKey: ["voice-diarization-model"] });
  }, [installQuery.data?.phase, open, queryClient]);
  const [speakerModelError, setSpeakerModelError] = useState<string | null>(null);
  const displayedSpeakerError = speakerModelError
    || (speakerModelQuery.error ? String(speakerModelQuery.error) : null)
    || (!speakerModelStatus?.ready ? installQuery.data?.error || (installQuery.error ? String(installQuery.error) : null) : null);
  const [importingSpeakers, setImportingSpeakers] = useState(false);
  const [credentialProfiles, setCredentialProfiles] = useState<AiProviderProfileRecord[]>([]);
  const [testingProfile, setTestingProfile] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void voiceApi.settingsGet()
      .then(setSettings)
      .catch((error) => pushToast({ tone: "error", title: "读取语音设置失败", detail: String(error) }))
      .finally(() => setLoading(false));
    void voiceApi.modelStatusGet()
      .then(setModelStatus)
      .catch((error) => pushToast({ tone: "error", title: "读取本地模型状态失败", detail: String(error) }));
    setSpeakerModelError(null);
    void projectMindApi.aiSettingsGet()
      .then((snapshot) => setCredentialProfiles(snapshot.profiles.filter((profile) => profile.enabled && profile.hasStoredKey)))
      .catch((error) => pushToast({ tone: "error", title: "读取密钥配置失败", detail: String(error) }));
  }, [open, pushToast]);

  function setProfile(kind: "none" | "paraformer" | "sense_voice_onnx") {
    const speechProfile: SpeechProfile | null = kind === "none"
      ? null
      : kind === "paraformer"
        ? { kind, endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference", model: "paraformer-realtime-v2", credentialProfileId: null }
        : { kind, modelPackageId: "sensevoice-small-int8-2024-07-17" };
    setSettings((current) => ({ ...current, speechProfile }));
  }

  async function importModel() {
    const selected = await desktopApi.pickDirectory("选择包含模型文件的文件夹，或解压后的上一级目录");
    if (!selected) return;
    setImporting(true);
    try {
      const status = await voiceApi.modelImport(selected);
      setModelStatus(status);
      pushToast({ tone: "success", title: "本地模型已校验并导入" });
    } catch (error) {
      pushToast({ tone: "error", title: "模型导入失败", detail: String(error) });
    } finally {
      setImporting(false);
    }
  }

  async function testProfile() {
    const profile = settings.speechProfile;
    if (profile?.kind !== "paraformer" || !profile.credentialProfileId) return;
    setTestingProfile(true);
    try {
      await voiceApi.profileTest({ endpoint: profile.endpoint, credentialProfileId: profile.credentialProfileId });
      pushToast({ tone: "success", title: "Paraformer 握手与结束测试通过" });
    } catch (error) {
      pushToast({ tone: "error", title: "Paraformer 连接测试失败", detail: String(error) });
    } finally {
      setTestingProfile(false);
    }
  }

  async function importSpeakerModel() {
    setImportingSpeakers(true);
    setSpeakerModelError(null);
    try {
      const selected = await desktopApi.pickDirectory("选择包含说话人模型文件的文件夹");
      if (!selected) return;
      queryClient.setQueryData(["voice-diarization-model"], await voiceApi.diarizationModelImport(selected));
      await queryClient.invalidateQueries({ queryKey: ["voice-diarization-model"] });
      pushToast({ tone: "success", title: "说话人模型已校验并导入" });
    } catch (error) { setSpeakerModelError(String(error)); }
    finally { setImportingSpeakers(false); }
  }

  async function installSpeakerModel() {
    if (speakerModelStatus?.ready || installBusy) return;
    setStartingInstall(true);
    setSpeakerModelError(null);
    try {
      queryClient.setQueryData(installKey, await voiceApi.diarizationModelInstall());
    } catch (error) { setSpeakerModelError(String(error)); }
    finally { setStartingInstall(false); }
  }

  async function save() {
    setSaving(true);
    try {
      await voiceApi.settingsUpsert(settings);
      pushToast({ tone: "success", title: "语音设置已保存" });
    } catch (error) {
      pushToast({ tone: "error", title: "保存语音设置失败", detail: String(error) });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="grid min-h-48 place-items-center text-text-muted"><LoaderCircle className="animate-spin motion-reduce:animate-none" /></div>;
  }

  const localRecognitionManagement = <>
    <p className="text-text-muted">选择包含 model.int8.onnx、tokens.txt 和 LICENSE 的文件夹，也可选择官方压缩包解压后的上一级目录。导入时会校验固定版本的 SHA-256。</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="secondary" disabled={importing} onClick={() => void importModel()}>{importing ? "导入并校验中…" : modelStatus?.ready ? "重新导入本地模型" : "导入本地模型"}</Button>
      <Button type="button" size="sm" variant="secondary" onClick={() => void desktopApi.openExternalUrl("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2")}>获取指定模型包</Button>
    </div>
  </>;

  return (
    <section aria-label="语音记录设置" className="grid max-w-2xl gap-5">
      <div>
        <h2 className="text-title font-semibold text-text">语音记录</h2>
        <p className="mt-1 text-body text-text-muted">麦克风始终跟随系统默认输入设备；开始录音前切换系统输入即可。</p>
      </div>

      <label className="grid gap-1.5 text-body text-text">
        <span className="font-medium">语音识别引擎</span>
        <select
          className="h-9 rounded-[var(--radius-6)] border border-border bg-bg px-3"
          value={settings.speechProfile?.kind ?? "none"}
          onChange={(event) => setProfile(event.target.value as "none" | "paraformer" | "sense_voice_onnx")}
        >
          <option value="none">仅录音（无字幕和转写）</option>
          <option value="paraformer">Paraformer 云端实时识别</option>
          <option value="sense_voice_onnx">SenseVoice-Small 本地识别</option>
        </select>
      </label>

      {settings.speechProfile?.kind === "paraformer" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-body"><span className="font-medium">服务地址</span><TextField value={settings.speechProfile.endpoint} onChange={(event) => setSettings((current) => ({ ...current, speechProfile: { ...current.speechProfile as Extract<SpeechProfile, { kind: "paraformer" }>, endpoint: event.target.value } }))} /></label>
          <label className="grid gap-1.5 text-body"><span className="font-medium">密钥配置</span>
            <select className="h-9 rounded-[var(--radius-6)] border border-border bg-bg px-3" value={settings.speechProfile.credentialProfileId ?? ""}
              onChange={(event) => setSettings((current) => ({ ...current, speechProfile: { ...current.speechProfile as Extract<SpeechProfile, { kind: "paraformer" }>, credentialProfileId: event.target.value ? Number(event.target.value) : null } }))}>
              <option value="">请选择已保存 API Key 的 AI Profile</option>
              {credentialProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · 尾号 {profile.apiKeyLast4}</option>)}
            </select>
          </label>
          <div className="sm:col-span-2"><Button type="button" size="sm" variant="secondary" disabled={testingProfile || !settings.speechProfile.credentialProfileId}
            onClick={() => void testProfile()}>{testingProfile ? "测试中…" : "测试 Paraformer 连接"}</Button></div>
        </div>
      ) : null}

      {settings.speechProfile?.kind === "sense_voice_onnx" ? (
        <div className="grid gap-2 rounded-[var(--radius-8)] border border-border p-3 text-body text-text">
          <p>{modelStatus?.detail ?? "正在检查本地模型…"}</p>
          {modelStatus?.ready ? <details className="text-caption text-text-muted"><summary className="cursor-pointer">本地模型管理</summary><div className="mt-2 grid gap-2">{localRecognitionManagement}</div></details> : localRecognitionManagement}
        </div>
      ) : null}

      {settings.speechProfile ? (
        <label className="flex items-center gap-2 text-body text-text">
          <input type="checkbox" checked={settings.livePreviewEnabled}
            onChange={(event) => setSettings((current) => ({ ...current, livePreviewEnabled: event.target.checked }))} />
          实时临时字幕{settings.speechProfile.kind === "sense_voice_onnx" ? "（增加本地模型推理开销）" : ""}
        </label>
      ) : null}

      <section aria-label="本地说话人模型" className="grid gap-2 border-t border-border pt-4 text-body text-text">
        <h3 className="font-medium">说话人区分</h3>
        <p className="text-text-muted">录音结束后自动区分说话人，可关联联系人。</p>
        {speakerModelStatus?.ready ? <p role="status">已启用</p> : <>
          <p className="text-caption text-text-muted">约 46 MB，仅首次下载需要联网，完成后离线使用。</p>
          {installQuery.data?.phase === "downloading" ? <div role="status" className="grid gap-1">
            <p>正在下载…{installQuery.data.totalBytes > 0 ? " " + Math.min(100, Math.floor(installQuery.data.downloadedBytes / installQuery.data.totalBytes * 100)) + "%" : ""}（{(installQuery.data.downloadedBytes / 1_000_000).toFixed(1)} MB{installQuery.data.totalBytes > 0 ? " / " + (installQuery.data.totalBytes / 1_000_000).toFixed(1) + " MB" : ""}）</p>
            <progress aria-label="说话人模型下载进度" className="w-full accent-[var(--color-accent)]" value={installQuery.data.downloadedBytes} max={Math.max(1, installQuery.data.totalBytes)} />
          </div> : installQuery.data?.phase === "verifying" ? <p role="status">正在校验并启用…</p> : installQuery.data?.phase === "ready" && speakerModelQuery.isFetching ? <p role="status">正在确认启用状态…</p> : null}
          {!installBusy && (installQuery.data?.phase !== "ready" || !speakerModelQuery.isFetching && !speakerModelQuery.isError) ? <div><Button type="button" size="sm" variant="primary" disabled={speakerModelQuery.isPending || installQuery.isPending || importingSpeakers} onClick={() => void installSpeakerModel()}>{installQuery.data?.phase === "ready" ? "重新准备" : installQuery.data?.phase === "failed" || speakerModelError || installQuery.isError ? "重试下载" : "下载并启用"}</Button></div> : null}
          {speakerModelQuery.isError ? <div><Button type="button" size="sm" variant="secondary" onClick={() => void speakerModelQuery.refetch()}>重新检查</Button></div> : null}
        </>}
        {displayedSpeakerError ? <p role="alert" className="text-caption text-danger">{displayedSpeakerError}</p> : null}
        <details className="text-caption text-text-muted">
          <summary className="cursor-pointer">高级选项</summary>
          <div className="mt-2 grid gap-2">
            <p>无需联网时，可选择已有说话人模型包所在的文件夹，由应用校验并导入。</p>
            <p>确认联系人后，仅在本 Workspace 本地保存声音特征用于后续自动匹配；不确定仍匿名。</p>
            <div><Button type="button" size="sm" variant="secondary" disabled={importingSpeakers || installBusy} onClick={() => void importSpeakerModel()}>{importingSpeakers ? "导入中…" : "从本地导入"}</Button></div>
          </div>
        </details>
      </section>

      <label className="grid gap-1.5 text-body text-text">
        <span className="font-medium">会议纪要和 AI 标题模型</span>
        <select aria-label="会议纪要和 AI 标题模型" className="h-9 rounded-[var(--radius-6)] border border-border bg-bg px-3"
          value={settings.textProfileId ?? ""}
          onChange={(event) => setSettings((current) => ({ ...current, textProfileId: event.target.value ? Number(event.target.value) : null }))}>
          <option value="">不自动生成纪要</option>
          {credentialProfiles.filter((profile) => profile.supportsText).map((profile) =>
            <option key={profile.id} value={profile.id}>{profile.name} · {profile.defaultModel}</option>)}
        </select>
        <span className="text-caption text-text-muted">选择有文本能力的 AI Profile。每录制约 15 分钟更新一次，结束时生成最终纪要，并覆盖当前标题。</span>
      </label>

      <label className="grid gap-1.5 text-body text-text">
        <span className="font-medium">字幕行数</span>
        <input type="range" min={2} max={8} value={settings.captionLines} onChange={(event) => setSettings((current) => ({ ...current, captionLines: Number(event.target.value) }))} />
        <span className="text-text-muted">{settings.captionLines} 行</span>
      </label>

      <label className="flex items-center gap-2 text-body text-text">
        <input type="checkbox" checked={settings.contextEnabled} onChange={(event) => setSettings((current) => ({ ...current, contextEnabled: event.target.checked }))} />
        识别时使用当前 Workspace 上下文
      </label>

      <div><Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存设置"}</Button></div>
    </section>
  );
}
