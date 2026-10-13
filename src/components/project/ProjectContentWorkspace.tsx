import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import type { ContentScope, ContentTab } from "../../lib/project-content-layout";
import { getContentLayout } from "../../lib/project-content-layout";
import { parseRecordFocusRoute } from "../../lib/record-focus-route";
import { projectPath, recordPath } from "../../lib/formatters";
import { projectRecordSaveKey } from "../../lib/record-save-coordinator";
import { useRecordSaveCoordinator } from "../../lib/record-save-runtime";
import { queryKeys } from "../../lib/queryKeys";
import type { ProjectPageData } from "../../lib/types";
import type { AgentSourceRef } from "../../lib/agent-types";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { openProjectContent } from "../../services/projectContentApi";
import { useProjectContentStore } from "../../state/project-content-store";
import { ProjectContentLayoutView, type ContentPageProps } from "./ProjectContentLayoutView";
import { registerProjectContentCloseGuard } from "../../lib/project-content-lifecycle";

const RecordPage = lazy(() => import("./ProjectNoteFocusPage").then(module => ({ default: module.ProjectNoteFocusPage })));
const FilePage = lazy(() => import("../document/ProjectFileContent").then(module => ({ default: module.ProjectFileContent })));
const SessionPage = lazy(() => import("../agent/ProjectSessionContent").then(module => ({ default: module.ProjectSessionContent })));
const FileIdentityActions = lazy(() => import("../document/ProjectFileIdentityActions").then(module => ({ default: module.ProjectFileIdentityActions })));
const FileSessionReference = lazy(() => import("../document/ProjectFileSessionReference").then(module => ({ default: module.ProjectFileSessionReference })));

export function projectContentTabRoute(projectId: number, tab: ContentTab) {
  return tab.object.kind === "record"
    ? `${recordPath(projectId, Number(tab.object.id))}${tab.view.sourceQuery ? `?${tab.view.sourceQuery}` : ""}`
    : `${projectPath(projectId)}?content=${encodeURIComponent(tab.id)}`;
}

function Page({ tab, visible, focused, registerCloseGuard, workspaceRoot, projectId, scope, onBack }: ContentPageProps & {
  workspaceRoot: string; projectId: number; scope: ContentScope; onBack: () => void;
}) {
  const [visited, setVisited] = useState(visible);
  const [fileSource, setFileSource] = useState<AgentSourceRef | null>(null);
  useEffect(() => { if (visible) setVisited(true); }, [visible]);
  const params = useMemo(() => new URLSearchParams(tab.view.sourceQuery), [tab.view.sourceQuery]);
  if (!visible && !visited) return null;
  return <Suspense fallback={<p role="status" className="p-5 text-sm text-text-muted">正在打开{tab.object.kind === "record" ? "记录" : tab.object.kind === "file" ? "文件" : "会话"}…</p>}>
    {tab.object.kind === "record" ? <RecordPage projectIdOverride={projectId} recordIdOverride={Number(tab.object.id)} visible={visible} focused={focused} embedded
      searchParamsOverride={params} onBack={onBack} registerCloseGuard={registerCloseGuard} />
      : tab.object.kind === "file" ? <div className="project-content__file-page"><FilePage workspaceRoot={workspaceRoot} projectId={projectId} fileId={Number(tab.object.id)} versionNumber={tab.view.versionNumber}
        line={tab.view.line} page={tab.view.page} sourceLocator={tab.view.sourceLocator} visible={visible} focused={focused}
        initialSourceMode={tab.view.sourceMode}
        initialView={fileSource?.fileVersion ? tab.view.fileViews?.[fileSource.fileVersion]
          ?? (tab.view.versionNumber === fileSource.fileVersion ? { scrollTop: tab.view.scrollTop, zoom: tab.view.zoom } : undefined) : undefined}
        identityRecovery={<FileIdentityActions workspaceRoot={workspaceRoot} projectId={projectId} fileId={Number(tab.object.id)} visible={visible} />}
        toolbarActions={<FileSessionReference workspaceRoot={workspaceRoot} projectId={projectId} fileId={Number(tab.object.id)} versionNumber={tab.view.versionNumber} sourceRef={fileSource} visible={visible} />}
        onSourceReady={setFileSource}
        onViewChange={view => {
          const store = useProjectContentStore.getState();
          const current = getContentLayout(store, scope).tabs.find(item => item.id === tab.id);
          if (!current) return;
          const version = fileSource?.fileVersion;
          const position = view.scrollTop !== undefined || view.zoom !== undefined;
          const fileViews = position && version ? { ...current.view.fileViews,
            [version]: { ...current.view.fileViews?.[version], ...(view.scrollTop !== undefined ? { scrollTop: view.scrollTop } : {}), ...(view.zoom !== undefined ? { zoom: view.zoom } : {}) } } : undefined;
          store.updateView(scope, tab.id, { ...view, ...(fileViews ? { fileViews } : {}) });
        }} /></div>
        : <SessionPage workspaceRoot={workspaceRoot} projectId={projectId} sessionId={String(tab.object.id)} visible={visible} focused={focused} />}
  </Suspense>;
}

/** Project-level wrapper; routing is an entry point, each page receives its own object context. */
export function ProjectContentWorkspace({ workspaceRoot, projectId, active, overview }: {
  workspaceRoot: string; projectId: number; active: boolean; overview: (visible: boolean) => ReactNode;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const coordinator = useRecordSaveCoordinator();
  const bindingQuery = useQuery({ queryKey: queryKeys.projectContentBinding(workspaceRoot), queryFn: () => recordDocumentApi.bindingGet(workspaceRoot), retry: false, staleTime: Infinity });
  const binding = bindingQuery.data;
  const scope = useMemo(() => binding ? { workspaceId: binding.workspaceId, projectId } : null, [binding?.workspaceId, projectId]);
  const layout = useProjectContentStore(state => scope ? getContentLayout(state, scope) : null);
  const [openingError, setOpeningError] = useState<string | null>(null);
  const [showOverview, setShowOverview] = useState(false);
  const route = active ? parseRecordFocusRoute(location.pathname) : null;
  const routeRecordId = route?.kind === "project" && route.projectId === projectId ? route.recordId : null;
  const routeKey = `${location.pathname}${location.search}`;
  const openedRoute = useRef<string | null>(null);
  const registerLeaveGuard = useCallback((prepare: () => Promise<void>) => registerProjectContentCloseGuard({ workspaceRoot, projectId, prepare }), [workspaceRoot, projectId]);
  const onOverview = useCallback(() => {
    setShowOverview(true);
    navigate(`${projectPath(projectId)}?view=overview`);
  }, [navigate, projectId]);
  useEffect(() => {
    if (!active || !scope || !layout) return;
    const params = new URLSearchParams(location.search);
    setShowOverview(params.get("view") === "overview");
    const contentId = params.get("content");
    if (contentId) {
      const current = getContentLayout(useProjectContentStore.getState(), scope);
      const pane = current.panes.find(item => item.tabIds.includes(contentId));
      if (pane) useProjectContentStore.getState().select(scope, pane.id, contentId);
    }
    if (routeRecordId === null || openedRoute.current === routeKey) return;
    const controller = new AbortController();
    const source = new URLSearchParams();
    for (const [key, value] of params) if (key.startsWith("source")) source.set(key, value);
    setOpeningError(null);
    void openProjectContent({ workspaceRoot, projectId, object: { kind: "record", id: routeRecordId, title: "记录" },
      ...(source.size ? { view: { sourceQuery: source.toString() } } : {}), reveal: false, signal: controller.signal,
    }).then(() => {
      if (!controller.signal.aborted) openedRoute.current = routeKey;
    }).catch(reason => {
      if (controller.signal.aborted) return;
      setOpeningError(reason instanceof Error ? reason.message : String(reason));
      // Failed deep links remain visible and closeable; no substituted object is loaded.
      useProjectContentStore.getState().open(scope, { kind: "record", id: routeRecordId, title: "不可用的记录" });
      openedRoute.current = routeKey;
    });
    return () => controller.abort();
  }, [active, scope, routeRecordId, routeKey, workspaceRoot, projectId]);
  const pageData = queryClient.getQueryData<ProjectPageData>(queryKeys.projectPage(projectId));
  // Older saved tabs lack voice metadata; the loaded Project supplies their Record identity.
  const presentedLayout = useMemo(() => layout && pageData ? {
    ...layout,
    tabs: layout.tabs.map(tab => {
      const record = tab.object.kind === "record" ? pageData.records?.find(item => item.id === Number(tab.object.id)) : undefined;
      return record ? { ...tab, object: { ...tab.object, isVoice: record.isVoice === true } } : tab;
    }),
  } : layout, [layout, pageData]);
  useEffect(() => {
    if (!scope || !layout || !pageData) return;
    const state = useProjectContentStore.getState();
    for (const tab of layout.tabs) {
      const title = tab.object.kind === "record" ? pageData.records?.find(item => item.id === Number(tab.object.id))?.title?.trim()
        : tab.object.kind === "file" ? pageData.projectDocuments?.find(item => item.id === Number(tab.object.id))?.name : null;
      if (title && title !== tab.object.title) state.updateTitle(scope, tab.id, title);
    }
  }, [pageData, scope, layout]);
  const contentShown = !showOverview && !!layout?.tabs.length;
  return <div className="h-full min-h-0 min-w-0">
    <div className="h-full min-h-0" hidden={contentShown} inert={contentShown}>{overview(active && !contentShown)}</div>
    {bindingQuery.error ? <p role="alert" className="p-4 text-sm">无法恢复项目内容：{String(bindingQuery.error)}<button type="button" onClick={() => void bindingQuery.refetch()}>重试</button></p> : null}
    {scope && presentedLayout ? <div className="h-full min-h-0" hidden={!contentShown} inert={!contentShown}>
      {openingError ? <p role="alert" className="project-content__error">{openingError}</p> : null}
      <ProjectContentLayoutView scope={scope} layout={presentedLayout} active={active && contentShown} onOverview={onOverview} registerLeaveGuard={registerLeaveGuard}
        onSelect={(paneId, tabId) => {
          useProjectContentStore.getState().select(scope, paneId, tabId);
          const tab = presentedLayout.tabs.find(item => item.id === tabId)!;
          setShowOverview(false); navigate(projectContentTabRoute(projectId, tab));
        }}
        onClose={async (tabId, guard) => {
          const tab = getContentLayout(useProjectContentStore.getState(), scope).tabs.find(item => item.id === tabId);
          if (!tab) return;
          if (guard) await guard();
          else if (tab.object.kind === "record") await coordinator?.flush(projectRecordSaveKey(projectId, Number(tab.object.id)));
          const current = await recordDocumentApi.bindingGet(workspaceRoot);
          if (!binding || current.workspaceId !== binding.workspaceId || current.generation !== binding.generation) throw new Error("工作区已切换，关闭已取消");
          useProjectContentStore.getState().close(scope, tabId);
          const next = getContentLayout(useProjectContentStore.getState(), scope);
          const selectedId = next.panes.find(item => item.id === next.focusedPaneId)?.selectedTabId;
          const selected = next.tabs.find(item => item.id === selectedId);
          navigate(selected ? projectContentTabRoute(projectId, selected) : projectPath(projectId), { replace: true });
        }}
        renderPage={props => <Page {...props} workspaceRoot={workspaceRoot} projectId={projectId} scope={scope} onBack={onOverview} />} />
    </div> : null}
  </div>;
}
