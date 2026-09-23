import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import type { SpeechProfile, VoiceModelPackageStatus, VoiceSettings } from "../../lib/voice-types";
import { desktopApi } from "../../services/desktopApi";
import { voiceApi } from "../../services/voiceApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { Button, TextField } from "../../ui/components";

const DEFAULT_SETTINGS: VoiceSettings = {
  speechProfile: null,
  textProfileId: null,
  translationProfileId: null,
  contextEnabled: false,
  captionLines: 4,
};

export function VoiceSettingsPanel({ open }: { open: boolean }) {
  const { pushToast } = useFeedbackStore();
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [modelStatus, setModelStatus] = useState<VoiceModelPackageStatus | null>(null);

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
  }, [open, pushToast]);

  function setProfile(kind: "none" | "paraformer" | "sense_voice_onnx") {
    const speechProfile: SpeechProfile | null = kind === "none"
      ? null
      : kind === "paraformer"
        ? { kind, endpoint: "", model: "paraformer-realtime-v2" }
        : { kind, modelPackageId: "sensevoice-small-int8-2024-07-17" };
    setSettings((current) => ({ ...current, speechProfile }));
  }

  async function importModel() {
    const selected = await desktopApi.pickDirectory("选择已解压的 SenseVoice 模型文件夹");
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

  return (
    <section aria-label="语音记录设置" className="grid max-w-2xl gap-5">
      <div>
        <h2 className="text-title font-semibold text-text">语音记录</h2>
        <p className="mt-1 text-body text-text-muted">麦克风始终跟随 macOS 系统默认输入设备；开始录音前切换系统输入即可。</p>
      </div>

      <label className="grid gap-1.5 text-body text-text">
        <span className="font-medium">语音识别引擎</span>
        <select
          className="h-9 rounded-[var(--radius-6)] border border-border bg-bg px-3"
          value={settings.speechProfile?.kind ?? "none"}
          onChange={(event) => setProfile(event.target.value as "none" | "paraformer" | "sense_voice_onnx")}
        >
          <option value="none">暂不识别（仅保存双轨音频）</option>
          <option value="paraformer">Paraformer 云端识别</option>
          <option value="sense_voice_onnx">SenseVoice-Small 本地识别</option>
        </select>
      </label>

      {settings.speechProfile?.kind === "paraformer" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-body"><span className="font-medium">服务地址</span><TextField value={settings.speechProfile.endpoint} onChange={(event) => setSettings((current) => ({ ...current, speechProfile: { ...current.speechProfile as Extract<SpeechProfile, { kind: "paraformer" }>, endpoint: event.target.value } }))} /></label>
          <label className="grid gap-1.5 text-body"><span className="font-medium">模型</span><TextField value={settings.speechProfile.model} onChange={(event) => setSettings((current) => ({ ...current, speechProfile: { ...current.speechProfile as Extract<SpeechProfile, { kind: "paraformer" }>, model: event.target.value } }))} /></label>
        </div>
      ) : null}

      {settings.speechProfile?.kind === "sense_voice_onnx" ? (
        <div className="grid gap-2 rounded-[var(--radius-8)] border border-border p-3 text-body text-text">
          <p>{modelStatus?.detail ?? "正在检查本地模型…"}</p>
          <p className="text-text-muted">导入已解压模型目录，需包含 model.int8.onnx、tokens.txt 和 LICENSE。导入时会校验固定版本的 SHA-256。</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" disabled={importing} onClick={() => void importModel()}>{importing ? "导入并校验中…" : "导入本地模型"}</Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => void desktopApi.openExternalUrl("https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2")}>获取指定模型包</Button>
          </div>
        </div>
      ) : null}

      <label className="grid gap-1.5 text-body text-text">
        <span className="font-medium">浮窗字幕行数</span>
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
