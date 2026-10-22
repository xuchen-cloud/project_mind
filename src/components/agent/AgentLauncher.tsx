import { lazy, Suspense, useState } from "react";
import { AiChatIcon } from "../icons/ContentTypeIcon";
import type { AgentScope } from "../../lib/agent-types";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import { Button } from "../../ui/components";
import "./agent.css";

const MemoryDialog = lazy(() => import("../memory/MemoryDialog").then(module => ({ default: module.MemoryDialog })));

export function AgentLauncher({ scope, workspaceRoot, visible = true }: {
  scope: AgentScope; workspaceRoot?: string; visible?: boolean;
}) {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const openPanel = useAgentPanelStore(state => state.openPanel);
  return <div className="agent-launcher gap-2">
    <Button size="sm" disabled={!visible || !workspaceRoot} onClick={() => setMemoryOpen(true)}>{scope.kind === "project" ? "项目理解" : "记忆"}</Button>
    <Button size="sm" leadingIcon={<AiChatIcon size={15} />} disabled={!visible || !workspaceRoot}
      title={!workspaceRoot ? "正在读取工作区信息" : undefined}
      onClick={() => { if (workspaceRoot) openPanel(workspaceRoot, scope); }}>助手</Button>
    {memoryOpen && visible && workspaceRoot && <Suspense fallback={null}><MemoryDialog scope={scope} workspaceRoot={workspaceRoot} onClose={() => setMemoryOpen(false)} /></Suspense>}
  </div>;
}
