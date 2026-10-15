import type { ExternalConnectionsStatus } from "../../lib/external-connections-types";
import { Button, StatusBadge } from "../../ui/components";

export function CliInstallation({ installation, busy, onInstall, onUninstall }: {
  installation: ExternalConnectionsStatus["cliInstallation"];
  busy: boolean;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  const canChange = !busy && !installation.conflict;
  return <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-t border-border pt-4 text-ui text-text-secondary">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-body font-medium text-text">终端命令</h3>
      <StatusBadge tone={installation.installed && installation.pathConfigured ? "success" : "neutral"}>
        {installation.installed ? installation.pathConfigured ? "已安装，PATH 已配置" : "已安装，PATH 待配置" : "未安装"}
      </StatusBadge>
      {installation.needsUpdate && installation.installed && <StatusBadge tone="warning">可更新</StatusBadge>}
    </div>
    <p className="min-w-0 break-all">命令位置：{installation.commandPath}</p>
    <p className="min-w-0 break-all">应用内 CLI：{installation.sourcePath ?? "文件不可用"}</p>
    {installation.profilePath && <p className="min-w-0 break-all">PATH 配置位置：{installation.profilePath}</p>}
    {installation.conflict && <p role="alert" className="break-words text-danger">{installation.conflict}</p>}
    {installation.manualInstruction && <p className="break-words">手动配置：{installation.manualInstruction}</p>}
    <p>点击安装会写入上述命令位置{installation.profilePath ? "并修改所示 PATH 配置" : ""}；请打开新终端使用。</p>
    <div className="flex flex-wrap gap-2">
      {(!installation.installed || installation.needsUpdate) && <Button size="sm" variant="secondary" disabled={!canChange || !installation.sourcePath} onClick={onInstall}>
        {installation.installed ? "更新终端命令" : "安装终端命令"}
      </Button>}
      {(installation.installed || installation.needsUpdate) && <Button size="sm" variant="ghost" disabled={!canChange} onClick={onUninstall}>卸载终端命令</Button>}
    </div>
  </div>;
}
