import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";

import { ProjectNoteFocusPage } from "../project/ProjectNoteFocusPage";
import { WorkspaceRecordFocusPage } from "../today/WorkspaceRecordFocusPage";

const MAX_RESIDENT_RECORD_FOCUSES = 2;

type RecordFocusRoute =
  | { key: string; kind: "project"; projectId: number; recordId: number }
  | { key: string; kind: "workspace"; recordId: number };

function parseRecordFocusRoute(pathname: string): RecordFocusRoute | null {
  const projectMatch = /^\/projects\/(\d+)\/records\/(\d+)$/u.exec(pathname);
  if (projectMatch) {
    const projectId = Number.parseInt(projectMatch[1] ?? "", 10);
    const recordId = Number.parseInt(projectMatch[2] ?? "", 10);
    if (Number.isFinite(projectId) && Number.isFinite(recordId)) {
      return {
        key: `project:${projectId}:${recordId}`,
        kind: "project",
        projectId,
        recordId,
      };
    }
  }

  const workspaceMatch = /^\/workspace\/records\/(\d+)$/u.exec(pathname);
  if (!workspaceMatch) return null;
  const recordId = Number.parseInt(workspaceMatch[1] ?? "", 10);
  return Number.isFinite(recordId)
    ? { key: `workspace:${recordId}`, kind: "workspace", recordId }
    : null;
}

function updateResidentFocusRoutes(
  current: readonly RecordFocusRoute[],
  active: RecordFocusRoute | null,
) {
  if (!active) {
    return current.slice(-1);
  }

  return [...current.filter((route) => route.key !== active.key), active].slice(
    -MAX_RESIDENT_RECORD_FOCUSES,
  );
}

function ResidentFocusPage({
  active,
  focusKey,
  children,
}: {
  active: boolean;
  focusKey: string;
  children: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (active || !rootRef.current?.contains(document.activeElement)) return;
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [active]);

  return (
    <div
      ref={rootRef}
      className="h-full min-h-0"
      data-record-focus-resident-key={focusKey}
      data-record-focus-active={active ? "true" : "false"}
      style={{ display: active ? undefined : "none" }}
      aria-hidden={active ? undefined : true}
      inert={!active}
    >
      {children}
    </div>
  );
}

export function RecordFocusResidentPages({ workspaceKey }: { workspaceKey: string }) {
  const location = useLocation();
  const activeFocus = useMemo(
    () => parseRecordFocusRoute(location.pathname),
    [location.pathname],
  );
  const [residency, setResidency] = useState<{
    workspaceKey: string;
    routes: RecordFocusRoute[];
  }>(() => ({ workspaceKey, routes: [] }));
  const currentRoutes = residency.workspaceKey === workspaceKey ? residency.routes : [];
  const renderedRoutes = updateResidentFocusRoutes(currentRoutes, activeFocus);

  useEffect(() => {
    setResidency((current) => {
      const baseRoutes = current.workspaceKey === workspaceKey ? current.routes : [];
      const nextRoutes = updateResidentFocusRoutes(baseRoutes, activeFocus);
      if (
        current.workspaceKey === workspaceKey &&
        current.routes.length === nextRoutes.length &&
        current.routes.every((route, index) => route.key === nextRoutes[index]?.key)
      ) {
        return current;
      }
      return { workspaceKey, routes: nextRoutes };
    });
  }, [activeFocus, workspaceKey]);

  return renderedRoutes.map((route) => {
    const active = route.key === activeFocus?.key;
    return (
      <ResidentFocusPage key={route.key} active={active} focusKey={route.key}>
        {route.kind === "project" ? (
          <ProjectNoteFocusPage
            projectIdOverride={route.projectId}
            noteIdOverride={route.recordId}
            visible={active}
          />
        ) : (
          <WorkspaceRecordFocusPage noteIdOverride={route.recordId} visible={active} />
        )}
      </ResidentFocusPage>
    );
  });
}
