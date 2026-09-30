import { SidebarTagItem } from "./SidebarTagItem";
import { HomeSidebarList } from "./HomeSidebarList";
import { HomeSidebarSplit } from "./HomeSidebarSplit";
import { HomeWorkspaceIdentity } from "./HomeWorkspaceIdentity";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PanelLeft, ChevronLeft, Compass, FileText, Mic, Plus } from "lucide-react";
import type { NoteRecord } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { projectMindApi } from "../../services/projectMindApi";
import { useUiStore, PROJECT_SIDEBAR_WIDTH_MAX_PX, PROJECT_SIDEBAR_WIDTH_MIN_PX } from "../../state/ui-store";
import { ResizeHandle } from "../../ui/components";
import nori from "../../assets/home/nori-bust.png";
import noriWordmark from "../../assets/home/norimind-wordmark.svg";

export function recentProjectRecordKey(workspaceRoot: string, projectId: number) {
  return `project-mind:recent-records:${workspaceRoot}:${projectId}`;
}

export function rememberProjectRecord(workspaceRoot: string, projectId: number, recordId: number) {
  const key = recentProjectRecordKey(workspaceRoot, projectId);
  let ids: number[] = [];
  try { const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]"); ids = Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : []; } catch { /* reset invalid history */ }
  try {
    localStorage.setItem(key, JSON.stringify([recordId, ...ids.filter((id) => id !== recordId)].slice(0, 20)));
    window.dispatchEvent(new Event("home-record-history-changed"));
  } catch { /* Navigation still works when device storage is unavailable. */ }
}

export function HomeProjectSidebar({
  projectId, projectName, workspaceRoot, records, selectedTagId,
  onTagChange, onOpenWorkspace, onOpenRecord, onCreateRecord,
}: {
  projectId: number;
  projectName: string;
  workspaceRoot: string;
  records: NoteRecord[];
  selectedTagId: number | null;
  onTagChange: (tagId: number | null) => void;
  onOpenWorkspace: () => void;
  onOpenRecord: (recordId: number) => void;
  onCreateRecord: () => void;
}) {
  const { projectSidebarCollapsed, projectSidebarWidthPx, toggleProjectSidebarCollapsed, setProjectSidebarWidthPx } = useUiStore();
  const [recentIds, setRecentIds] = useState<number[]>([]);
  const tagsQuery = useQuery({
    queryKey: queryKeys.projectTags.project(projectId),
    queryFn: () => projectMindApi.projectTagSettingsGet({ projectId }),
    staleTime: Infinity,
  });
  useEffect(() => {
    const update = () => {
      try {
        const value: unknown = JSON.parse(localStorage.getItem(recentProjectRecordKey(workspaceRoot, projectId)) ?? "[]");
        setRecentIds(Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : []);
      } catch { setRecentIds([]); }
    };
    update();
    window.addEventListener("home-record-history-changed", update);
    return () => window.removeEventListener("home-record-history-changed", update);
  }, [workspaceRoot, projectId]);
  const recent = useMemo(() => {
    const byId = new Map(records.map((record) => [record.id, record]));
    const opened = recentIds.map((id) => byId.get(id)).filter((record): record is NoteRecord => Boolean(record));
    const fallback = [...records].filter((record) => !recentIds.includes(record.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return [...opened, ...fallback].slice(0, 5);
  }, [recentIds, records]);
  if (projectSidebarCollapsed) return <aside className="sidebar-dock sidebar-dock--left"><button type="button" className="sidebar-dock__surface" aria-label="展开项目侧边栏" onClick={toggleProjectSidebarCollapsed}><Compass size={18} /></button></aside>;
  return <aside className="home-side" style={{ width: projectSidebarWidthPx }} aria-label="项目导航侧边栏">
    <ResizeHandle label="调整项目侧边栏宽度" edge="right" value={projectSidebarWidthPx} min={PROJECT_SIDEBAR_WIDTH_MIN_PX} max={PROJECT_SIDEBAR_WIDTH_MAX_PX} onChange={setProjectSidebarWidthPx} className="right-0" />
    <div data-tauri-drag-region className="home-side__top"><button type="button" aria-label="切换左侧栏" aria-expanded={true} onClick={toggleProjectSidebarCollapsed}><PanelLeft size={16} /></button><button type="button" className="home-side__workspace-tab" onClick={onOpenWorkspace}>我的工作区</button></div>
      <div className="home-side__brand"><img className="home-side__mascot" src={nori} alt="" /><div className="home-side__brand-copy"><img className="home-side__wordmark" src={noriWordmark} alt="NoriMind" /><HomeWorkspaceIdentity onOpenWorkspace={onOpenWorkspace} /></div><button type="button" aria-label="收起项目侧边栏" onClick={toggleProjectSidebarCollapsed}><ChevronLeft size={17} /></button></div>

    <HomeSidebarSplit key={`${workspaceRoot}:${projectId}`} storageKey={`home-sidebar-split:project:${workspaceRoot}:${projectId}`} upper={<><div className="home-side__heading"><span>最近记录</span><button type="button" aria-label="新增记录" onClick={onCreateRecord}><Plus size={20} /></button></div>
      <HomeSidebarList label="最近记录列表">{recent.length ? recent.map((record) => <button key={record.id} type="button" className="home-side__item" onClick={() => { rememberProjectRecord(workspaceRoot, projectId, record.id); onOpenRecord(record.id); }} title={record.title ?? "未命名记录"}>{record.isVoice ? <Mic size={18} /> : <FileText size={18} />}<span>{record.title?.trim() || "未命名记录"}</span></button>) : <p className="home-side__empty">最近打开的记录会显示在这里</p>}
      </HomeSidebarList></>} lower={<><div className="home-side__heading"><span>项目标签</span></div><HomeSidebarList label="项目标签列表">
      <button type="button" className="home-side__item" onClick={() => onTagChange(null)}><FileText size={18} /><span>全部记录</span></button>
      {(tagsQuery.data?.tags ?? []).map((tag) => <SidebarTagItem key={tag.id} tag={tag} projectId={projectId} selected={selectedTagId === tag.id} onSelect={onTagChange} />)}
    </HomeSidebarList></>} />
  </aside>;
}
