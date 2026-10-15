import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { DshSettingsHost } from "@project-mind/dsh-ui/adapters";
import { DSH_BUSY_MESSAGE } from "../../lib/dsh-host-events";
import { useLocation, useParams } from "react-router-dom";
import { getErrorMessage } from "../../lib/errors";
import { parseRouteId } from "../../lib/formatters";
import { queryKeys } from "../../lib/queryKeys";
import type { AiSettingsSnapshot } from "../../lib/types";
import { dshAssistantApi } from "../../services/dshAssistantApi";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import { useUiStore } from "../../state/ui-store";
import { Button } from "../../ui/components/Button";
import "../agent/dsh-assistant.css";

export function DshSettingsPanel({ open }: { open: boolean }) {
  const params = useParams();
  const location = useLocation();
  const binding = useAgentPanelStore(state => state.binding);
  const routeProject = parseRouteId(params.projectId);
  const workspacePage = location.pathname === "/projects" || location.pathname.startsWith("/workspace");
  const projectId = routeProject ?? (!workspacePage && binding?.scope.kind === "project" ? binding.scope.projectId : null);
  const client = useQueryClient();
  const openSettings = useUiStore(state => state.openSettings);
  const subscribe = useCallback((notify: () => void) => client.getQueryCache().subscribe(event => {
    if (event.query.queryKey[0] === queryKeys.aiSettings[0]) notify();
  }), [client]);
  const snapshot = useCallback(() => {
    const settings = client.getQueryData<AiSettingsSnapshot>(queryKeys.aiSettings);
    const general = settings?.bindings.find(value => value.capability === "default");
    return JSON.stringify([general, settings?.profiles.find(value => value.id === general?.profileId),
      settings?.aiSecretsUnlocked, settings?.securityMode, settings?.network]);
  }, [client]);
  const fingerprint = useSyncExternalStore(subscribe, snapshot);
  const [mode, setMode] = useState<"plugins" | "settings">("plugins");
  const [attempt, setAttempt] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = useAgentPanelStore(state => state.runningBinding);
  const key = JSON.stringify(["settings", binding?.workspaceRoot, projectId, fingerprint, attempt]);
  const ready = open && loadedKey === key && !running;
  const identity = JSON.stringify([open, key]);
  const current = useRef(identity);
  current.current = identity;
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const hostError = useCallback((message: string) => { if (open && alive.current && current.current === identity) setError(message); }, [open, identity]);

  useEffect(() => {
    if (!open || running) return;
    let cancelled = false;
    setLoadedKey(null); setError(null);
    void dshAssistantApi.start(key, projectId).then(() => { if (!cancelled) setLoadedKey(key); }, reason => {
      if (!cancelled) setError(getErrorMessage(reason, "DSH 助手启动失败"));
    });
    return () => { cancelled = true; };
  }, [open, projectId, key, running]);

  return <section className="dsh-settings" aria-label="DSH 助手设置">
    <div className="dsh-settings__tabs" role="group" aria-label="DSH 设置页面">
      <Button size="sm" variant={mode === "plugins" ? "secondary" : "ghost"} aria-pressed={mode === "plugins"} onClick={() => setMode("plugins")}>插件</Button>
      <Button size="sm" variant={mode === "settings" ? "secondary" : "ghost"} aria-pressed={mode === "settings"} onClick={() => setMode("settings")}>设置</Button>
    </div>
    {running ? <p role="status">{DSH_BUSY_MESSAGE}</p> : error ? <div role="alert"><p>{error}</p>
      <Button size="sm" onClick={() => setAttempt(value => value + 1)}>重试</Button>
      <Button size="sm" variant="ghost" onClick={() => openSettings("ai-models")}>模型设置</Button>
    </div> : !ready ? <p role="status">正在启动 DSH 助手…</p> : null}
    <div className="dsh-settings__host">
      {ready ? <DshSettingsHost key={key} projectId={projectId} mode={mode} onError={hostError} /> : null}
    </div>
  </section>;
}
