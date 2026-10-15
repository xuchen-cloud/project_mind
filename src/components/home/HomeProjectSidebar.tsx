import { RecordIcon } from "../icons/ContentTypeIcon";
import { SidebarTagItem } from "./SidebarTagItem";
import { HomeSidebarList } from "./HomeSidebarList";
import { HomeProjectFiles } from "./HomeProjectFiles";
import { ProjectSidebarSessions } from "./ProjectSidebarSessions";
import { HomeSidebarFooter, HomeWorkspaceIdentity } from "./HomeWorkspaceIdentity";
import { useEffect, useMemo, useState, type ComponentProps } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Compass, Plus, Pencil, Trash2 } from "lucide-react";
import type { NoteRecord } from "../../lib/types";
import { queryKeys } from "../../lib/queryKeys";
import { projectMindApi } from "../../services/projectMindApi";
import { useUiStore, PROJECT_SIDEBAR_WIDTH_MAX_PX, PROJECT_SIDEBAR_WIDTH_MIN_PX } from "../../state/ui-store";
import { ActionContextMenu, ResizeHandle, SearchField } from "../../ui/components";
import { useFeedbackStore } from "../../state/feedback-store";
import nori from "../../assets/home/nori-bust.png";
import { recentProjectRecordKey, rememberProjectRecord } from "./project-record-history";
import "./project-navigation.css";

export function HomeProjectSidebar({
  projectId, projectName, workspaceRoot, project, documents, records, selectedTagId,
  onTagChange, onOpenProject, onOpenWorkspace, onOpenRecord, onCreateRecord, activeRecordId, onRenameRecord, onDeleteRecord,
}: {
  projectId: number;
  projectName: string;
  workspaceRoot: string;
  project: ComponentProps<typeof HomeProjectFiles>["project"];
  documents: ComponentProps<typeof HomeProjectFiles>["documents"];
  records: NoteRecord[];
  selectedTagId: number | null;
  activeRecordId?: number | null;
  onTagChange: (tagId: number | null) => void;
  onOpenProject: () => void;
  onOpenWorkspace: () => void;
  onOpenRecord: (recordId: number) => void;
  onCreateRecord: () => void;
  onRenameRecord?: (id: number, title: string) => Promise<unknown>;
  onDeleteRecord?: (id: number) => Promise<unknown>;
}) {
  const { projectSidebarCollapsed, projectSidebarWidthPx, toggleProjectSidebarCollapsed, setProjectSidebarWidthPx } = useUiStore();
  const pushToast = useFeedbackStore(state => state.pushToast);
  const [query, setQuery] = useState("");
  const [recentIds, setRecentIds] = useState<number[]>([]);
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: number; title: string } | null>(null);
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
  const visibleRecords = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const rank = new Map(recentIds.map((id, index) => [id, index]));
    return records.filter(record =>
      (selectedTagId === null || record.tags?.some(tag => tag.id === selectedTagId)) &&
      (!normalized || [record.title ?? "", record.contentMarkdown, ...(record.tags ?? []).map(tag => tag.label)].some(text => text.toLocaleLowerCase().includes(normalized)))
    ).sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || b.updatedAt.localeCompare(a.updatedAt));
  }, [query, records, recentIds, selectedTagId]);
  if (projectSidebarCollapsed) return <aside className="sidebar-dock sidebar-dock--left"><button type="button" className="sidebar-dock__surface" aria-label="展开项目侧边栏" onClick={toggleProjectSidebarCollapsed}><Compass size={18} /></button></aside>;
  return <aside className="home-side project-navigation" style={{ width: projectSidebarWidthPx }} aria-label="项目导航侧边栏">
    <ResizeHandle label="调整项目侧边栏宽度" edge="right" value={projectSidebarWidthPx} min={PROJECT_SIDEBAR_WIDTH_MIN_PX} max={PROJECT_SIDEBAR_WIDTH_MAX_PX} onChange={setProjectSidebarWidthPx} className="right-0" />
    <div className="home-side__brand"><img className="home-side__mascot" src={nori} alt="" /><HomeWorkspaceIdentity projectName={projectName} onOpenProject={onOpenProject} onOpenWorkspace={onOpenWorkspace} /><button type="button" aria-label="收起项目侧边栏" onClick={toggleProjectSidebarCollapsed}><ChevronLeft size={17} /></button></div>
    <div className="project-navigation__search"><SearchField aria-label="搜索项目内容" placeholder="搜索记录、会话和文件" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <section className="project-navigation__tags" aria-label="项目标签">
      <HomeSidebarList label="项目标签列表"><div className="project-navigation__tag-cloud">
        <button type="button" className="entity-tag-chip entity-tag-chip--interactive" aria-pressed={selectedTagId === null} onClick={() => onTagChange(null)}>全部</button>
        {(tagsQuery.data?.tags ?? []).map(tag => <SidebarTagItem key={tag.id} appearance="chip" tag={tag} projectId={projectId} selected={selectedTagId === tag.id} onSelect={onTagChange} />)}
      </div></HomeSidebarList>
      {tagsQuery.isError ? <button type="button" className="home-side__empty" onClick={() => void tagsQuery.refetch()}>标签加载失败，点击重试</button> : null}
    </section>
    <div className="project-navigation__modules">
      <section className="project-navigation__section" aria-label="项目记录">
        <div className="home-side__heading"><span>记录</span><button type="button" aria-label="新增记录" onClick={onCreateRecord}><Plus size={16} /></button></div>
        <HomeSidebarList label="项目记录列表" searchKey={`${query}:${selectedTagId}`}>
          {visibleRecords.map(record => editing?.id === record.id ? <input key={record.id} className="home-side__rename" aria-label="重命名记录" autoFocus value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })}
            onBlur={() => { void onRenameRecord?.(editing.id, editing.title).catch(error => pushToast({ tone: "error", title: "重命名记录失败", detail: String(error) })); setEditing(null); }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(null); }} /> :
            <button key={record.id} type="button" className={`home-side__item ${record.id === activeRecordId ? "is-active" : ""}`} title={record.title?.trim() || "未命名记录"}
              onContextMenu={event => { if (!onRenameRecord && !onDeleteRecord) return; event.preventDefault(); setMenu({ id: record.id, x: event.clientX, y: event.clientY }); }}
              onClick={() => { rememberProjectRecord(workspaceRoot, projectId, record.id); onOpenRecord(record.id); }}><RecordIcon size={16} isVoice={record.isVoice} /><span>{record.title?.trim() || "未命名记录"}</span></button>)}
          {!visibleRecords.length ? <p className="home-side__empty">{query.trim() || selectedTagId !== null ? "没有匹配的记录" : "暂无记录"}</p> : null}
        </HomeSidebarList>
      </section>
      <ProjectSidebarSessions workspaceRoot={workspaceRoot} projectId={projectId} query={query} enabled={!projectSidebarCollapsed} />
      <section className="project-navigation__section project-navigation__files" aria-label="项目文件导航"><HomeProjectFiles project={project} documents={documents} filter={{ query, tagId: selectedTagId }} /></section>
    </div>
    <HomeSidebarFooter />
    {menu ? <ActionContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} actions={[
      { label: "重命名", icon: Pencil, disabled: !onRenameRecord, onSelect: () => setEditing({ id: menu.id, title: records.find(record => record.id === menu.id)?.title ?? "" }) },
      { label: "删除记录", icon: Trash2, tone: "danger", disabled: !onDeleteRecord, onSelect: () => { void onDeleteRecord?.(menu.id).catch(error => pushToast({ tone: "error", title: "删除记录失败", detail: String(error) })); } },
    ]} /> : null}
  </aside>;
}
