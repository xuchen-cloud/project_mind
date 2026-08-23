import { useRef } from "react";

import { Button, Dialog, TextField } from "../../ui/components";

interface CreateWorkspaceDialogProps {
  open: boolean;
  rootPath: string;
  password: string;
  pending: boolean;
  error: string | null;
  onRootPathChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onPickRoot: () => void;
  onClose: () => void;
  onSubmit: () => void;
}

export function CreateWorkspaceDialog({
  open,
  rootPath,
  password,
  pending,
  error,
  onRootPathChange,
  onPasswordChange,
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

        <label className="grid gap-1.5">
          <span className="text-ui font-medium text-text-muted">
            Workspace 密码
          </span>
          <TextField
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="用于加密保存的 AI API Key"
          />
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

interface UnlockWorkspaceSecretsDialogProps {
  open: boolean;
  pending: boolean;
  error: string | null;
  password: string;
  onPasswordChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}

export function UnlockWorkspaceSecretsDialog({
  open,
  pending,
  error,
  password,
  onPasswordChange,
  onClose,
  onSubmit,
}: UnlockWorkspaceSecretsDialogProps) {
  const passwordRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="解锁 Workspace Secrets"
      description="输入当前 workspace 密码后，可以继续使用已保存的 AI API Key。"
      widthClassName="max-w-lg"
      layerClassName="z-[60]"
      initialFocusRef={passwordRef}
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
            {pending ? "解锁中..." : "解锁"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-ui font-medium text-text-muted">
            Workspace 密码
          </span>
          <TextField
            ref={passwordRef}
            type="password"
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="输入密码后继续"
          />
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
