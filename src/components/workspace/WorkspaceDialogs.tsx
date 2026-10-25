import { useRef } from "react";

import { Button, Dialog, TextField } from "../../ui/components";

interface CreateWorkspaceDialogProps {
  open: boolean;
  rootPath: string;
  pending: boolean;
  error: string | null;
  onRootPathChange: (value: string) => void;
  onPickRoot: () => void;
  onClose: () => void;
  onSubmit: () => void;
}

export function CreateWorkspaceDialog({
  open,
  rootPath,
  pending,
  error,
  onRootPathChange,
  onPickRoot,
  onClose,
  onSubmit,
}: CreateWorkspaceDialogProps) {
  const rootPathRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建 Workspace"
      description="会在所选目录下创建 .project-mind 隐藏目录，并初始化数据库与配置。"
      widthClassName="max-w-2xl"
      initialFocusRef={rootPathRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={pending}
            onClick={onSubmit}
          >
            {pending ? "创建中..." : "创建 Workspace"}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <label className="grid gap-1.5">
          <span className="text-ui font-medium text-text-muted">
            Workspace 根目录
          </span>
          <div className="flex gap-2">
            <TextField
              ref={rootPathRef}
              value={rootPath}
              onChange={(event) => onRootPathChange(event.target.value)}
              placeholder="例如：/Users/alex/workspaces/customer-success"
              className="flex-1"
            />
            <Button type="button" variant="secondary" onClick={onPickRoot}>
              选择
            </Button>
          </div>
        </label>

        {error ? (
          <div role="alert" className="rounded-[var(--radius-8)] border border-danger/30 bg-danger/8 px-3 py-2 text-ui text-danger">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
