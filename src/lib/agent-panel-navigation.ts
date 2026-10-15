import { useAgentPanelStore } from "../state/agent-panel-store";

/** Called only after an explicit, verified object navigation succeeds. */
export function revealAgentObjectPage() {
  const panel = useAgentPanelStore.getState();
  if (window.innerWidth <= 900) panel.closePanel();
  else if (panel.expanded) panel.toggleExpanded();
}
