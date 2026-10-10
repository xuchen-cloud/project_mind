import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { getErrorMessage } from "../../lib/errors";
import { queryKeys } from "../../lib/queryKeys";
import type { AiNetworkSettings, AiProxyMode, AiSettingsSnapshot } from "../../lib/types";
import { projectMindApi } from "../../services/projectMindApi";
import { useFeedbackStore } from "../../state/feedback-store";
import { Button, SectionHeader, SurfaceCard, TextField } from "../../ui/components";
import {
  settingsCardClassName,
  settingsFieldClassName,
  settingsFieldHintClassName,
  settingsFieldLabelClassName,
  settingsSelectClassName,
} from "./shared";

export function AiNetworkSettingsPanel({ network }: { network: AiNetworkSettings }) {
  const queryClient = useQueryClient();
  const { pushToast, setStatus } = useFeedbackStore();
  const [mode, setMode] = useState<AiProxyMode>(network.mode);
  const [proxyUrl, setProxyUrl] = useState(network.proxyUrl ?? "");
  const [username, setUsername] = useState(network.username ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [savePending, setSavePending] = useState(false);

  useEffect(() => {
    setMode(network.mode);
    setProxyUrl(network.proxyUrl ?? "");
    setUsername(network.username ?? "");
    setPassword("");
    setClearPassword(false);
  }, [network.mode, network.proxyUrl, network.username, network.hasStoredPassword]);

  const save = async () => {
    setSavePending(true);
    let saved: AiNetworkSettings;
    try {
      saved = await projectMindApi.aiNetworkSettingsUpsert({
        mode,
        proxyUrl: mode === "custom" ? proxyUrl.trim() : null,
        ...(mode === "custom" ? {
          username: username.trim() || null,
          ...(clearPassword ? { password: "" } : password ? { password } : {}),
        } : {}),
      });
    } catch (error) {
      const detail = getErrorMessage(error, "保存 AI 连接设置失败");
      setStatus({ tone: "error", label: "Error", message: "保存 AI 连接设置失败" });
      pushToast({ tone: "error", title: "保存 AI 连接设置失败", detail });
      setSavePending(false);
      return;
    }
    setPassword("");
    setClearPassword(false);
    queryClient.setQueryData<AiSettingsSnapshot>(queryKeys.aiSettings, (current) =>
      current ? { ...current, network: saved } : current,
    );
    setStatus({ tone: "success", label: "Saved", message: "AI 连接设置已保存" });
    setSavePending(false);
    void queryClient.invalidateQueries({ queryKey: queryKeys.aiSettings });
  };

  const dirty =
    mode !== network.mode ||
    (mode === "custom" && (
      proxyUrl.trim() !== (network.proxyUrl ?? "") ||
      username.trim() !== (network.username ?? "") ||
      password.length > 0 ||
      clearPassword
    ));

  return (
    <SurfaceCard subtle className={settingsCardClassName}>
      <SectionHeader eyebrow="Network" title="AI 连接" />
      <p className="mt-2 text-body text-text-muted">
        应用于工作区内的 AI 请求，包括对话和后台任务。保存后新请求使用此设置，正在进行的请求不受影响。
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2.5">
        <label className={`${settingsFieldClassName} min-w-44 flex-1`}>
          <span className={settingsFieldLabelClassName}>连接方式</span>
          <select
            className={settingsSelectClassName}
            value={mode}
            disabled={savePending}
            onChange={(event) => setMode(event.target.value as AiProxyMode)}
          >
            <option value="system">系统代理（默认）</option>
            <option value="custom">自定义代理</option>
            <option value="direct">直连</option>
          </select>
        </label>
        {mode === "custom" ? (
          <label className={`${settingsFieldClassName} min-w-56 flex-[2]`}>
            <span className={settingsFieldLabelClassName}>代理地址</span>
            <TextField
              fieldSize="sm"
              value={proxyUrl}
              disabled={savePending}
              onChange={(event) => setProxyUrl(event.target.value)}
              placeholder="http://127.0.0.1:7890"
            />
          </label>
        ) : null}
      </div>
      {mode === "custom" ? (
        <div className="mt-2.5 flex flex-wrap items-end gap-2.5">
          <label className={`${settingsFieldClassName} min-w-44 flex-1`}>
            <span className={settingsFieldLabelClassName}>代理用户名（可选）</span>
            <TextField
              fieldSize="sm"
              value={username}
              disabled={savePending}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className={`${settingsFieldClassName} min-w-44 flex-1`}>
            <span className={settingsFieldLabelClassName}>代理密码（可选）</span>
            <TextField
              fieldSize="sm"
              type="password"
              value={password}
              disabled={savePending || clearPassword}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={network.hasStoredPassword && !clearPassword && proxyUrl.trim() === (network.proxyUrl ?? "") && username.trim() === (network.username ?? "") ? "已保存，留空保持" : "留空表示不设置密码"}
              autoComplete="new-password"
            />
          </label>
          {network.hasStoredPassword ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={savePending}
              onClick={() => {
                setPassword("");
                setClearPassword((current) => !current);
              }}
            >
              {clearPassword ? "保留已保存密码" : "清除已保存密码"}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="mt-2.5 flex justify-end">
        <Button
          type="button"
          size="sm"
          variant="primary"
          disabled={!dirty || savePending}
          onClick={() => void save()}
        >
          {savePending ? "保存中..." : "保存连接方式"}
        </Button>
      </div>
      <p className={`mt-2 ${settingsFieldHintClassName}`}>
        {mode === "system"
          ? "优先使用 HTTP_PROXY / HTTPS_PROXY；否则读取 macOS 的静态 HTTP/HTTPS 代理或 Windows 的统一静态代理。暂不支持 PAC/WPAD。"
          : mode === "custom"
            ? "支持 HTTP/HTTPS 代理地址，可在地址或下方单独填写凭据；密码保存在本地且不会回显。更换地址或用户名时，留空会清除原密码。可用接入配置的“测试”检查连接。"
            : "AI 请求将直接连接服务商；可用下方接入配置的“测试”检查连接。"}
      </p>
    </SurfaceCard>
  );
}
