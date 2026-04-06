import { useState } from "react";
import { FolderOpen } from "lucide-react";
import type { ProjectCreateInput } from "../../lib/types";
import { PROJECT_STATUS_OPTIONS } from "../../lib/constants";
import { desktopApi } from "../../services/desktopApi";
import { Button, Dialog, TextField } from "../../ui/components";

interface CreateProjectModalProps {
  onClose: () => void;
  onSubmit: (input: ProjectCreateInput) => void;
  isPending: boolean;
}

export function CreateProjectModal({ onClose, onSubmit, isPending }: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState("active");
  const [workspaceRoot, setWorkspaceRoot] = useState("");

  const handlePickFolder = async () => {
    const selected = await desktopApi.pickDirectory("选择工作区文件夹");
    if (typeof selected === "string") setWorkspaceRoot(selected);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="创建项目"
      widthClassName="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="submit"
            form="create-project-form"
            variant="primary"
            disabled={isPending}
          >
            {isPending ? "创建中..." : "创建项目"}
          </Button>
        </>
      }
    >
      <div className="mb-5 flex items-center gap-3 rounded-[var(--radius-8)] border border-border bg-bg-subtle px-4 py-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-8)] bg-bg text-text-muted">
          <FolderOpen size={18} />
        </div>
        <div>
          <p className="text-title font-medium text-text">Project Mind Workspace</p>
          <p className="text-body text-text-muted">项目目录将作为本地工作区根路径。</p>
        </div>
      </div>

      <form
        id="create-project-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || !workspaceRoot.trim()) return;
          onSubmit({ name, summary, status, workspaceRoot });
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-ui font-medium text-text-muted">项目名称</span>
          <TextField
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="例如：AIGC 商业化项目"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-ui font-medium text-text-muted">项目简介</span>
          <textarea
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            rows={4}
            className="w-full rounded-[var(--radius-6)] border border-border bg-bg px-3 py-2 text-body text-text outline-none transition-[border-color,background-color,box-shadow] duration-[160ms] ease-[var(--ease-soft)] placeholder:text-text-soft hover:border-border-strong focus:border-accent"
            placeholder="说明当前阶段、目标、关键约束和判断依据。"
          />
        </label>
        <div className="grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
          <label className="block space-y-1.5">
            <span className="text-ui font-medium text-text-muted">状态</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-8 w-full rounded-[var(--radius-6)] border border-border bg-bg px-3 text-body text-text outline-none transition-[border-color,background-color] duration-[160ms] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent"
            >
              {PROJECT_STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-ui font-medium text-text-muted">工作区目录</span>
            <div className="flex gap-2">
              <TextField
                value={workspaceRoot}
                onChange={(e) => setWorkspaceRoot(e.target.value)}
                required
                className="flex-1"
                placeholder="/Users/xuchen/workspaces/project-name"
              />
              <Button type="button" variant="secondary" onClick={handlePickFolder}>
                选择
              </Button>
            </div>
          </label>
        </div>
      </form>
    </Dialog>
  );
}
