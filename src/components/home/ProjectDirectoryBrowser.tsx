import { useEffect, useRef, useState } from "react";
import { ChevronRight, File, Folder, RefreshCw } from "lucide-react";
import { getErrorMessage } from "../../lib/errors";
import { projectDirectoryApi, type ProjectDirectoryEntry, type ProjectDirectoryPreview } from "../../services/projectDirectoryApi";
import { Button, Dialog, IconButton } from "../../ui/components";
import { HomeSidebarList } from "./HomeSidebarList";
import { useProjectFileNavigation } from "../../lib/project-file-navigation";
import { requestDshFileReference } from "../../lib/dsh-host-events";
import "./project-directory.css";

function byteLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ProjectDirectoryFilePreviewDialog({ projectId, file, line, onClose }: { projectId: number; file: Pick<ProjectDirectoryEntry, "name" | "relativePath">; line?: number; onClose: () => void }) {
  const [preview, setPreview] = useState<ProjectDirectoryPreview | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const textElement = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (preview?.kind === "text" && line && line > 0 && textElement.current) {
      const height = parseFloat(getComputedStyle(textElement.current).lineHeight) || 20;
      textElement.current.scrollTop = (line - 1) * height;
    }
  }, [preview, line]);
  useEffect(() => {
    let cancelled = false;
    void projectDirectoryApi.preview(projectId, file.relativePath).then(result => {
      if (!cancelled) setPreview(result);
    }, cause => { if (!cancelled) setError(getErrorMessage(cause, "无法预览文件")); });
    return () => { cancelled = true; };
  }, [projectId, file.relativePath]);

  async function openLocally() {
    setOpening(true);
    setError("");
    try { await projectDirectoryApi.open(projectId, file.relativePath); }
    catch (cause) { setError(getErrorMessage(cause, "无法打开文件")); }
    finally { setOpening(false); }
  }
  return <Dialog open title={file.name} description={file.relativePath} onClose={onClose}
    widthClassName="max-w-4xl" bodyClassName="project-directory__preview"
    footer={<><Button size="sm" variant="ghost" onClick={() => { requestDshFileReference(projectId, file.relativePath); onClose(); }}>引用到助手</Button><Button size="sm" disabled={opening} onClick={() => void openLocally()}>在本地应用打开</Button></>}>
    {error && <p role="alert">{error}</p>}
    {!preview && !error && <p role="status">正在读取文件…</p>}
    {preview?.kind === "text" && <pre ref={textElement}>{preview.text}</pre>}
    {preview?.kind === "image" && <img src={`data:${preview.mime};base64,${preview.base64}`} alt={file.name} />}
    {preview?.kind === "open" && <p>{preview.reason === "tooLarge" ? "文件超过预览大小限制，请在本地应用打开。" : "此文件不支持文本或图片预览，请在本地应用打开。"}</p>}
  </Dialog>;
}

/** Physical project files, independent of DB-managed Files and the assistant. */
export function ProjectDirectoryBrowser({ projectId }: { projectId: number }) {
  const revision = useProjectFileNavigation(state => state.revisions[projectId] ?? 0);
  const [relativePath, setRelativePath] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [entries, setEntries] = useState<ProjectDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<ProjectDirectoryEntry | null>(null);
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
    <p className="project-directory__hint">浏览当前项目文件夹</p>
    <HomeSidebarList key={relativePath} label="项目目录内容">
      {loading && <p className="project-directory__message" role="status">正在读取目录…</p>}
      {error && <p className="project-directory__message" role="alert">{error}</p>}
      {!loading && !error && entries.length === 0 && <p className="project-directory__message">此目录为空</p>}
      {entries.map(entry => <button key={entry.relativePath} type="button" className="project-directory__entry"
        onClick={() => entry.kind === "directory" ? setRelativePath(entry.relativePath) : setSelected(entry)}>
        {entry.kind === "directory" ? <Folder size={16} aria-hidden="true" /> : <File size={16} aria-hidden="true" />}
        <span className="project-directory__name" title={entry.name}>{entry.name}</span>
        {entry.kind === "file" ? <span className="project-directory__bytes">{byteLabel(entry.bytes)}</span> : <ChevronRight size={12} aria-hidden="true" />}
      </button>)}
    </HomeSidebarList>
    {selected && <ProjectDirectoryFilePreviewDialog key={`${projectId}:${selected.relativePath}`} projectId={projectId} file={selected} onClose={() => setSelected(null)} />}
  </div>;
}
