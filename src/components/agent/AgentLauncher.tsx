import { AiChatIcon } from "../icons/ContentTypeIcon";
import type { AgentScope } from "../../lib/agent-types";
import { useAgentPanelStore } from "../../state/agent-panel-store";
import { Button } from "../../ui/components";
import "./agent.css";

export function AgentLauncher({ scope, workspaceRoot, visible = true }: {
  scope: AgentScope; workspaceRoot?: string; visible?: boolean;
}) {
  const openPanel = useAgentPanelStore(state => state.openPanel);
  return <div className="agent-launcher">
    <Button size="sm" leadingIcon={<AiChatIcon size={15} />} disabled={!visible || !workspaceRoot}
      title={!workspaceRoot ? "正在读取工作区信息" : undefined}
      onClick={() => { if (workspaceRoot) openPanel(workspaceRoot, scope); }}>助手</Button>
  </div>;
}
