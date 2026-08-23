import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";

import { parseRecordFocusRoute, type RecordFocusRoute } from "../../lib/record-focus-route";
import {
  projectRecordSaveKey,
  workspaceRecordSaveKey,
} from "../../lib/record-save-coordinator";
import { useRecordSaveCoordinator } from "../../lib/record-save-runtime";
import { queryKeys } from "../../lib/queryKeys";
import type { ProjectPageData, WorkspacePageData } from "../../lib/types";
import {
  loadProjectNoteFocusPageModule,
  loadWorkspaceRecordFocusPageModule,
} from "../../routes/record-focus-modules";
import { PageLoadingSkeleton } from "../../ui/components";
import {
  recordFocusDraftFromRecord,
  recordFocusDraftFromSnapshot,
  type RecordFocusDraft,
} from "./recordFocusDraft";

const ProjectNoteFocusPage = lazy(loadProjectNoteFocusPageModule);
const WorkspaceRecordFocusPage = lazy(loadWorkspaceRecordFocusPageModule);

const MAX_RESIDENT_RECORD_FOCUSES = 2;

interface RecordFocusResidencyValue {
  activeFocus: RecordFocusRoute | null;
  routes: RecordFocusRoute[];
}

const RecordFocusResidencyContext = createContext<RecordFocusResidencyValue | null>(null);

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

function CachedRecordFocusPage({ route }: { route: RecordFocusRoute }) {
  const queryClient = useQueryClient();
  const saveCoordinator = useRecordSaveCoordinator();
  let draft: RecordFocusDraft | null = null;

  if (route.kind === "project") {
    const snapshot = saveCoordinator?.getLatestSnapshot(
      projectRecordSaveKey(route.projectId, route.recordId),
    );
    if (snapshot?.scope === "project") {
      draft = recordFocusDraftFromSnapshot(snapshot);
    } else {
      const record = queryClient
        .getQueryData<ProjectPageData>(queryKeys.projectPage(route.projectId))
        ?.records?.find((candidate) => candidate.id === route.recordId);
      draft = record ? recordFocusDraftFromRecord(record) : null;
    }
  } else {
    const snapshot = saveCoordinator?.getLatestSnapshot(
      workspaceRecordSaveKey(route.recordId),
    );
    if (snapshot?.scope === "workspace") {
      draft = recordFocusDraftFromSnapshot(snapshot);
    } else {
      const record = queryClient
        .getQueryData<WorkspacePageData>(queryKeys.workspacePage)
        ?.records?.find((candidate) => candidate.id === route.recordId);
      draft = record ? recordFocusDraftFromRecord(record) : null;
    }
  }

  if (!draft) {
    return <PageLoadingSkeleton variant="record" label="正在打开记录" />;
  }

  return (
    <article className="h-full min-h-0 overflow-auto px-6 py-6" data-record-focus-cached-fallback>
      {draft.title ? <h1 className="text-lg font-medium text-text">{draft.title}</h1> : null}
      <div
        className="rich-editor__content mt-4"
        dangerouslySetInnerHTML={{ __html: draft.content.html }}
      />
    </article>
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

function useRecordFocusResidency(
  workspaceKey: string | null,
  residentProjectIds?: readonly number[],
) {
  const location = useLocation();
  const activeFocus = useMemo(
    () => parseRecordFocusRoute(location.pathname),
    [location.pathname],
  );
  const [residency, setResidency] = useState<{
    workspaceKey: string;
    routes: RecordFocusRoute[];
  }>(() => ({ workspaceKey: workspaceKey ?? "", routes: [] }));
  const currentRoutes =
    workspaceKey !== null && residency.workspaceKey === workspaceKey
      ? residency.routes
      : [];
  const renderedRoutes = updateResidentFocusRoutes(currentRoutes, activeFocus).filter(
    (route) =>
      route.kind === "workspace" ||
      residentProjectIds === undefined ||
      residentProjectIds.includes(route.projectId),
  );

  useLayoutEffect(() => {
    setResidency((current) => {
      if (workspaceKey === null) {
        return { workspaceKey: "", routes: [] };
      }
      const baseRoutes = current.workspaceKey === workspaceKey ? current.routes : [];
      const nextRoutes = updateResidentFocusRoutes(baseRoutes, activeFocus).filter(
        (route) =>
          route.kind === "workspace" ||
          residentProjectIds === undefined ||
          residentProjectIds.includes(route.projectId),
      );
      if (
        current.workspaceKey === workspaceKey &&
        current.routes.length === nextRoutes.length &&
        current.routes.every((route, index) => route.key === nextRoutes[index]?.key)
      ) {
        return current;
      }
      return { workspaceKey, routes: nextRoutes };
    });
  }, [activeFocus, residentProjectIds, workspaceKey]);

  return { activeFocus, routes: renderedRoutes };
}

export function RecordFocusResidencyProvider({
  children,
  residentProjectIds,
  workspaceKey,
}: {
  children: React.ReactNode;
  residentProjectIds: readonly number[];
  workspaceKey: string | null;
}) {
  const value = useRecordFocusResidency(workspaceKey, residentProjectIds);
  return (
    <RecordFocusResidencyContext.Provider value={value}>
      {children}
    </RecordFocusResidencyContext.Provider>
  );
}

function matchesResidencyScope(
  route: RecordFocusRoute,
  projectId: number | null | undefined,
) {
  if (projectId === undefined) return true;
  return projectId === null
    ? route.kind === "workspace"
    : route.kind === "project" && route.projectId === projectId;
}

export function RecordFocusResidentPages({
  projectId,
  workspaceKey,
}: {
  projectId?: number | null;
  workspaceKey?: string;
}) {
  const sharedResidency = useContext(RecordFocusResidencyContext);
  const standaloneResidency = useRecordFocusResidency(
    sharedResidency ? null : (workspaceKey ?? null),
  );
  const residency = sharedResidency ?? standaloneResidency;

  return residency.routes.filter((route) => matchesResidencyScope(route, projectId)).map((route) => {
    const active = route.key === residency.activeFocus?.key;
    return (
      <ResidentFocusPage key={route.key} active={active} focusKey={route.key}>
        {route.kind === "project" ? (
          <Suspense fallback={<CachedRecordFocusPage route={route} />}>
            <ProjectNoteFocusPage
              projectIdOverride={route.projectId}
              recordIdOverride={route.recordId}
              visible={active}
            />
          </Suspense>
        ) : (
          <Suspense fallback={<CachedRecordFocusPage route={route} />}>
            <WorkspaceRecordFocusPage recordIdOverride={route.recordId} visible={active} />
          </Suspense>
        )}
      </ResidentFocusPage>
    );
  });
}
