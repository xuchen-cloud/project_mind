import { useRef, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { ProjectCreateInput } from "../../lib/types";
import { PROJECT_STATUS_OPTIONS } from "../../lib/constants";
import { Button, Dialog, TextField } from "../../ui/components";

interface CreateProjectModalProps {
  workspaceRoot: string;
  onClose: () => void;
  onSubmit: (input: ProjectCreateInput) => void;
  isPending: boolean;
}

export function CreateProjectModal({
  workspaceRoot,
  onClose,
  onSubmit,
  isPending,
}: CreateProjectModalProps) {
  const [name, setName] = useState("");
  const [quickNote, setQuickNote] = useState("");
  const [status, setStatus] = useState("active");
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      open
      onClose={onClose}
      title="创建项目"
      widthClassName="max-w-2xl"
      initialFocusRef={nameRef}
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
          <p className="text-title font-medium text-text">ProjectMind Workspace</p>
          <p className="text-body text-text-muted">新项目会直接创建在当前 workspace 根目录下。</p>
        </div>
      </div>

      <form
        id="create-project-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          onSubmit({ name, quickNote, status });
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-ui font-medium text-text-muted">项目名称</span>
          <TextField
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="例如：AIGC 商业化项目"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-ui font-medium text-text-muted">QuickNote</span>
          <textarea
            value={quickNote}
            onChange={(e) => setQuickNote(e.target.value)}
            rows={4}
            className="w-full rounded-[var(--radius-6)] border border-border bg-bg px-3 py-2 text-body text-text outline-none transition-[border-color,background-color,box-shadow] duration-[var(--duration-standard)] ease-[var(--ease-soft)] placeholder:text-text-soft hover:border-border-strong focus:border-accent"
            placeholder="写下当前阶段、目标、关键约束和判断依据。"
          />
        </label>
        <div className="grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
          <label className="block space-y-1.5">
            <span className="text-ui font-medium text-text-muted">状态</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="h-8 w-full rounded-[var(--radius-6)] border border-border bg-bg px-3 text-body text-text outline-none transition-[border-color,background-color] duration-[var(--duration-standard)] ease-[var(--ease-soft)] hover:border-border-strong focus:border-accent"
            >
              {PROJECT_STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-ui font-medium text-text-muted">当前 Workspace</span>
            <TextField value={workspaceRoot} readOnly className="flex-1" />
          </label>
        </div>
      </form>
    </Dialog>
  );
}
