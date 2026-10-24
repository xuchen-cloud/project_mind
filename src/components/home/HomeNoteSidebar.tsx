import { RecordIcon } from "../icons/ContentTypeIcon";
import { useMemo, useState, type ReactNode } from "react";
import { PanelLeft, Pencil, Plus, Trash2 } from "lucide-react";
import { HomeSidebarFooter, HomeWorkspaceIdentity } from "./HomeWorkspaceIdentity";
import { HomeSidebarList } from "./HomeSidebarList";
import { HomeSidebarSplit } from "./HomeSidebarSplit";
import { ActionContextMenu, ResizeHandle, SearchField } from "../../ui/components";
import { useUiStore, PROJECT_SIDEBAR_WIDTH_MIN_PX, PROJECT_SIDEBAR_WIDTH_MAX_PX } from "../../state/ui-store";
import nori from "../../assets/home/nori-bust.png";

type RecordItem = { id: number; title?: string | null; contentMarkdown: string; updatedAt: string; isVoice?: boolean };
export function HomeNoteSidebar({ workspaceRoot, projectId, records, filePanel, activeRecordId, onOpenWorkspace, onOpenRecord, onCreateRecord, onRenameRecord, onDeleteRecord }: {
  workspaceRoot: string; projectId?: number; records: RecordItem[]; filePanel?: ReactNode; activeRecordId: number;
  onRenameRecord?: (id: number, title: string) => Promise<unknown>; onDeleteRecord?: (id: number) => Promise<unknown>;
  onOpenWorkspace: () => void; onOpenRecord: (id: number) => void; onCreateRecord: () => void;
}) {
  const { projectSidebarCollapsed, projectSidebarWidthPx, toggleProjectSidebarCollapsed, setProjectSidebarWidthPx } = useUiStore();
  const [menu, setMenu] = useState<{ id: number; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ id: number; title: string } | null>(null);
  const [query, setQuery] = useState("");
  const recent = useMemo(() => [...records].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id).filter(record => `${record.title ?? ""} ${record.contentMarkdown}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [records, query]);
  if (projectSidebarCollapsed) return <aside className="sidebar-dock sidebar-dock--left"><button className="sidebar-dock__surface" aria-label="展开笔记侧边栏" onClick={toggleProjectSidebarCollapsed}><PanelLeft size={18} /></button></aside>;
  const recordList = <><div className="home-side__heading"><span>最近记录</span><button aria-label="新增记录" onClick={onCreateRecord}><Plus size={18} /></button></div>
    <SearchField className="home-side__search" aria-label="搜索最近记录" placeholder="搜索记录" value={query} onChange={event => setQuery(event.target.value)} />
    <HomeSidebarList label="最近记录列表" searchKey={query}>{recent.map(record => editing?.id === record.id ? <input key={record.id} aria-label="重命名记录" className="home-side__rename" autoFocus value={editing.title} onChange={event => setEditing({ ...editing, title: event.target.value })} onBlur={() => { void onRenameRecord?.(editing.id, editing.title); setEditing(null); }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") setEditing(null); }} /> : <button key={record.id} className={`home-side__item ${record.id === activeRecordId ? "is-active" : ""}`} onContextMenu={event => { if (!onRenameRecord && !onDeleteRecord) return; event.preventDefault(); setMenu({ id: record.id, x: event.clientX, y: event.clientY }); }} onClick={() => { onOpenRecord(record.id); }} title={record.title || "未命名记录"}><RecordIcon size={18} isVoice={record.isVoice} aria-label={record.isVoice ? "语音记录" : undefined} /><span>{record.title || "未命名记录"}</span></button>)}{!recent.length && <p className="home-side__empty">{query ? "没有匹配的记录" : "暂无记录"}</p>}</HomeSidebarList></>;
  return <aside className="home-side home-note-sidebar" style={{ width: projectSidebarWidthPx }} aria-label="笔记导航侧边栏">
    <ResizeHandle label="调整笔记侧边栏宽度" edge="right" value={projectSidebarWidthPx} min={PROJECT_SIDEBAR_WIDTH_MIN_PX} max={PROJECT_SIDEBAR_WIDTH_MAX_PX} onChange={setProjectSidebarWidthPx} className="right-0" />
    <div data-tauri-drag-region className="home-side__top"><button aria-label="切换左侧栏" onClick={toggleProjectSidebarCollapsed}><PanelLeft size={16} /></button><button className="home-side__workspace-tab" onClick={onOpenWorkspace}>我的工作区</button></div>
    <div className="home-side__brand"><img className="home-side__mascot" src={nori} alt="" /><HomeWorkspaceIdentity onOpenWorkspace={onOpenWorkspace} /></div>
    {projectId ? <HomeSidebarSplit storageKey={`home-note-split:${workspaceRoot}:${projectId}`} upper={recordList} lower={filePanel} /> : <div className="home-side__scroll home-note-sidebar__single"><section className="home-side__section">{recordList}</section></div>}
    <HomeSidebarFooter />
    {menu && <ActionContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} actions={[
      { label: "重命名", icon: Pencil, disabled: !onRenameRecord, onSelect: () => setEditing({ id: menu.id, title: records.find(record => record.id === menu.id)?.title ?? "" }) },
      { label: "删除记录", icon: Trash2, tone: "danger", disabled: !onDeleteRecord, onSelect: () => { void onDeleteRecord?.(menu.id); } },
    ]} />}
  </aside>;
}
