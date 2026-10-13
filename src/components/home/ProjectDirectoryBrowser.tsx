import { useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, RefreshCw } from "lucide-react";
import { getErrorMessage } from "../../lib/errors";
import { projectDirectoryApi, type ProjectDirectoryEntry } from "../../services/projectDirectoryApi";
import { Button, IconButton } from "../../ui/components";
import { HomeSidebarList } from "./HomeSidebarList";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { openProjectFilePreview } from "../../lib/project-file-navigation";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";
import type { WorkspaceStatusSnapshot } from "../../lib/types";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../lib/queryKeys";
import "./project-directory.css";
import { FileIcon } from "../document/FileIcon";

function byteLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Physical directory browsing; opening and scanning use the common File service. */
export function ProjectDirectoryBrowser({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const revision = useProjectFileNavigation(state => state.revisions[projectId] ?? 0);
  const [relativePath, setRelativePath] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<ProjectDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [scan, setScan] = useState<{ count: number; running: boolean; cancelled: boolean; complete: boolean; failures: { relativePath: string; reason: string }[]; excluded: { relativePath: string; reason: string }[] } | null>(null);
  const scanEpoch = useRef(0);
  const scanCancelled = useRef(false);
  useEffect(() => () => { scanEpoch.current++; scanCancelled.current = true; }, [projectId]);
  async function scanDirectory() {
    const epoch = ++scanEpoch.current;
    scanCancelled.current = false;
    const current = () => epoch === scanEpoch.current;
    setError("");
    setScan({ count: 0, running: true, cancelled: false, complete: false, failures: [], excluded: [] });
    try {
      const root = queryClient.getQueryData<WorkspaceStatusSnapshot>(queryKeys.workspaceStatus)?.currentWorkspace?.rootPath;
      if (!root) throw new Error("请先打开工作区");
      const binding = await recordDocumentApi.bindingGet(root);
      let cursor: string | null = null;
      let complete = false;
      do {
        if (!current() || scanCancelled.current) break;
        const result = await projectFileApi.scan(binding, projectId, cursor);
        if (!current()) return;
        // A failed directory retains its native cursor for an explicit retry.
        // Do not request that same failing page indefinitely or duplicate its rows.
        if (cursor !== null && result.nextCursor === cursor && result.failures.length > 0) break;
        setScan(previous => previous ? { ...previous, count: previous.count + result.files.length,
          failures: [...previous.failures, ...result.failures], excluded: [...previous.excluded, ...result.excluded] } : previous);
        cursor = result.nextCursor;
        complete = result.complete;
      } while (cursor);
      if (!current()) return;
      setScan(previous => previous ? { ...previous, running: false, cancelled: scanCancelled.current, complete } : previous);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectPage(projectId) });
    } catch (reason) {
      if (current()) { setError(getErrorMessage(reason, "目录纳管失败")); setScan(previous => previous ? { ...previous, running: false } : previous); }
    }
  }
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setEntries([]);
    void projectDirectoryApi.list(projectId, relativePath).then(result => {
      if (!cancelled) { setEntries(result); setLoading(false); }
    }, cause => {
      if (!cancelled) { setError(getErrorMessage(cause, "无法读取项目目录")); setLoading(false); }
    });
    return () => { cancelled = true; };
  }, [projectId, relativePath, refresh, revision]);

  const parts = relativePath ? relativePath.split("/") : [];
  return <div className="project-directory">
    <div className="project-directory__toolbar">
      <nav aria-label="项目目录路径">
        <button type="button" aria-current={relativePath === "" ? "page" : undefined} onClick={() => setRelativePath("")}>项目根目录</button>
        {parts.map((part, index) => <span key={parts.slice(0, index + 1).join("/")}>
          <ChevronRight size={12} aria-hidden="true" />
          <button type="button" aria-current={index === parts.length - 1 ? "page" : undefined} onClick={() => setRelativePath(parts.slice(0, index + 1).join("/"))}>{part}</button>
        </span>)}
      </nav>
      <IconButton size="sm" aria-label="刷新项目目录" title="刷新项目目录" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /></IconButton>
    </div>
    <div className="project-directory__hint">浏览当前项目文件夹 · 打开时登记 File 与版本
      <Button size="sm" variant="ghost" disabled={scan?.running} onClick={() => void scanDirectory()}>纳管整个目录</Button>
      {scan?.running ? <Button size="sm" variant="ghost" onClick={() => { scanCancelled.current = true; }}>取消</Button> : null}
    </div>
    {scan ? <details className="project-directory__hint"><summary role={scan.running ? "status" : undefined}>{scan.running ? "正在纳管" : scan.cancelled ? "已取消" : scan.complete ? "纳管完成" : "纳管未完成"}：{scan.count} 个 File，{scan.failures.length} 项失败，{scan.excluded.length} 项排除</summary>
      {!scan.running && !scan.cancelled && !scan.complete ? <p>目录读取未完成，请处理失败项后重新纳管；已登记的 File 会保留。</p> : null}
      <p>内部数据目录、符号链接和特殊文件不纳管；读取与快照限制按 File 服务执行。</p>
      <div className="project-directory__scan-items"><HomeSidebarList label="目录纳管结果">
      {scan.failures.map(item => <p key={`failure:${item.relativePath}`}>{item.relativePath}：{item.reason}</p>)}
      {scan.excluded.map(item => <p key={`excluded:${item.relativePath}`}>{item.relativePath}：{item.reason === "internal" ? "应用内部数据" : item.reason === "symlink" ? "符号链接" : "特殊文件"}</p>)}
      </HomeSidebarList></div>
    </details> : null}
    <HomeSidebarList key={relativePath} label="项目目录内容">
      {loading && <p className="project-directory__message" role="status">正在读取目录…</p>}
      {error && <p className="project-directory__message" role="alert">{error}</p>}
      {!loading && !error && entries.length === 0 && <p className="project-directory__message">此目录为空</p>}
      {entries.map(entry => <button key={entry.relativePath} type="button" className="project-directory__entry"
        onClick={() => entry.kind === "directory" ? setRelativePath(entry.relativePath) : openProjectFilePreview(projectId, entry.relativePath)}>
        {entry.kind === "directory" ? <Folder size={16} aria-hidden="true" /> : <FileIcon name={entry.name} size={18} />}
        <span className="project-directory__name" title={entry.name}>{entry.name}</span>
        {entry.kind === "file" ? <span className="project-directory__bytes">{byteLabel(entry.bytes)}</span> : <ChevronRight size={12} aria-hidden="true" />}
      </button>)}
    </HomeSidebarList>
  </div>;
}
