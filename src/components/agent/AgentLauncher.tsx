import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import type { AgentScope } from "../../lib/agent-types";
import { Button } from "../../ui/components";
import { AgentPanel } from "./AgentPanel";
import "./agent.css";

export function AgentLauncher({ scope, workspaceRoot, visible = true }: {
  scope: AgentScope; workspaceRoot?: string; visible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const identity = `${workspaceRoot ?? ""}:${scope.kind === "project" ? scope.projectId : "workspace"}`;
  useEffect(() => { if (!visible) setOpen(false); }, [visible]);
  return <div className="agent-launcher">
    <Button size="sm" leadingIcon={<MessageCircle size={15} />} disabled={!visible || !workspaceRoot}
      title={!workspaceRoot ? "正在读取工作区信息" : undefined} onClick={() => { setOpened(true); setOpen(true); }}>助手</Button>
    {opened ? <AgentPanel key={identity} scope={scope} workspaceRoot={workspaceRoot} open={open && visible} onClose={() => setOpen(false)} /> : null}
  </div>;
}
