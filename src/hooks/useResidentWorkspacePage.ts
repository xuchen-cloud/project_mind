import { useEffect, useState } from "react";

interface ResidentWorkspacePageOptions {
  active: boolean;
  enabled: boolean;
  workspaceKey: string | null;
}

/**
 * Pins the Workspace Overview after its first visit.
 *
 * Unlike project overview pages, Workspace is a singleton and must never enter
 * the bounded project LRU. It stays mounted until the workspace scope itself is
 * cleared or page caching is disabled.
 */
export function useResidentWorkspacePage({
  active,
  enabled,
  workspaceKey,
}: ResidentWorkspacePageOptions) {
  const [residentWorkspaceKey, setResidentWorkspaceKey] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceKey || !enabled) {
      setResidentWorkspaceKey(null);
      return;
    }

    if (active) {
      setResidentWorkspaceKey(workspaceKey);
    }
  }, [active, enabled, workspaceKey]);

  // Include the first visit in the route-change render so Workspace mounts
  // immediately instead of waiting for the effect.
  return Boolean(
    workspaceKey &&
      enabled &&
      (active || residentWorkspaceKey === workspaceKey),
  );
}
