import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { getErrorMessage } from "../../lib/errors";
import {
  tauriAppUpdater,
  type AppUpdate,
  type AppUpdaterClient,
} from "../../services/appUpdater";
import { Button } from "../../ui/components";

interface UpdateSettingsPanelProps {
  updater?: AppUpdaterClient;
}

export function UpdateSettingsPanel({ updater = tauriAppUpdater }: UpdateSettingsPanelProps) {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [versionReadFailed, setVersionReadFailed] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<AppUpdate | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void updater
      .currentVersion()
      .then((version) => {
        if (active) {
          setCurrentVersion(version);
        }
      })
      .catch((nextError) => {
        if (active) {
          setVersionReadFailed(true);
          setError(getErrorMessage(nextError, "读取当前版本失败"));
        }
      });
    return () => {
      active = false;
    };
  }, [updater]);

  const handleCheck = async () => {
    setChecking(true);
    setChecked(false);
    setError(null);
    try {
      if (versionReadFailed) {
        setVersionReadFailed(false);
        try {
          setCurrentVersion(await updater.currentVersion());
        } catch (nextError) {
          setVersionReadFailed(true);
          setError(getErrorMessage(nextError, "读取当前版本失败"));
          return;
        }
      }
      setAvailableUpdate(await updater.check());
      setChecked(true);
    } catch (nextError) {
      setAvailableUpdate(null);
      setError(getErrorMessage(nextError, "检查更新失败"));
    } finally {
      setChecking(false);
    }
  };

  const handleInstall = async () => {
    if (!availableUpdate) {
      return;
    }
    setInstalling(true);
    setError(null);
    try {
      await updater.install(availableUpdate);
      setInstalled(true);
    } catch (nextError) {
      setError(getErrorMessage(nextError, "安装更新失败"));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="grid gap-5" data-testid="update-settings-panel">
      <div className="grid gap-1">
        <h2 className="text-title font-semibold text-text">应用更新</h2>
        <p className="text-body leading-6 text-text-soft">
          从 ProjectMind 的 Beta 发布通道获取经过签名的桌面更新。
        </p>
      </div>

      <div className="grid gap-3 rounded-[var(--radius-8)] border border-border bg-bg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-body font-medium text-text">
              {currentVersion
                ? `当前版本 ${currentVersion}`
                : versionReadFailed
                  ? "当前版本读取失败"
                  : "正在读取当前版本…"}
            </p>
            <p className="text-ui text-text-soft">更新不会删除或移动现有 Workspace。</p>
          </div>
          <Button
            type="button"
            size="sm"
            leadingIcon={<RefreshCw size={14} />}
            disabled={checking}
            onClick={() => void handleCheck()}
          >
            {checking ? "正在检查…" : error ? "重新检查" : "检查更新"}
          </Button>
        </div>

        {error ? (
          <p className="border-t border-border pt-3 text-ui text-danger" role="alert">
            {error}
          </p>
        ) : null}

        {!error && availableUpdate ? (
          <div className="grid gap-3 border-t border-border pt-3">
            <div className="grid gap-1">
              <p className="text-body font-medium text-text">
                发现新版本 {availableUpdate.version}
              </p>
              {availableUpdate.notes ? (
                <p className="whitespace-pre-wrap text-ui leading-6 text-text-soft">
                  {availableUpdate.notes}
                </p>
              ) : null}
            </div>
            <div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                leadingIcon={<Download size={14} />}
                disabled={installing || installed}
                onClick={() => void handleInstall()}
              >
                {installing ? "正在安装…" : "下载并安装"}
              </Button>
            </div>
            {installed ? (
              <p className="text-ui text-success" role="status">
                更新已安装，正在重新启动…
              </p>
            ) : null}
          </div>
        ) : !error && checked ? (
          <p className="border-t border-border pt-3 text-ui text-text-soft" role="status">
            当前已是最新版本。
          </p>
        ) : null}
      </div>
    </div>
  );
}
