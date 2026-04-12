import { Circle } from "lucide-react";

import { fileTagColorValue } from "../../lib/constants";
import type { FileTagRecord } from "../../lib/types";
import { Button, Dialog } from "../../ui/components";

interface DocumentImportTagDialogProps {
  paths: string[];
  tags: FileTagRecord[];
  selectedTagIds: number[];
  onToggleTag: (tagId: number) => void;
  onClose: () => void;
  onConfirm: () => void;
  onManageTags: () => void;
}

export function DocumentImportTagDialog({
  paths,
  tags,
  selectedTagIds,
  onToggleTag,
  onClose,
  onConfirm,
  onManageTags,
}: DocumentImportTagDialogProps) {
  return (
    <Dialog
      open
      title="选择导入标签"
      description={`这次会把相同的 tag 一次性应用到 ${paths.length} 个待导入文件。`}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="button" variant="primary" onClick={onConfirm}>
            开始导入
          </Button>
        </>
      }
      widthClassName="max-w-lg"
    >
      <div className="grid gap-4">
        <div className="rounded-[var(--radius-8)] border border-border bg-bg-subtle px-3 py-3">
          <p className="text-ui font-medium text-text-muted">本次文件</p>
          <div className="mt-2 grid gap-1 text-ui text-text-soft">
            {paths.slice(0, 4).map((path) => (
              <p key={path} className="truncate" title={path}>
                {path}
              </p>
            ))}
            {paths.length > 4 ? <p>另外还有 {paths.length - 4} 个文件</p> : null}
          </div>
        </div>

        <div className="grid gap-1">
          {tags.map((tag) => (
            <label
              key={tag.id}
              className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-6)] border border-border px-3 py-2 text-ui text-text-muted transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text"
            >
              <input
                type="checkbox"
                checked={selectedTagIds.includes(tag.id)}
                onChange={() => onToggleTag(tag.id)}
              />
              <Circle
                size={10}
                className="fill-current"
                style={{ color: fileTagColorValue(tag.colorKey) }}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{tag.label}</span>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <span className="text-ui text-text-soft">
            不选也可以，空选择代表这些文件暂时不挂 tag。
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={onManageTags}>
            管理标签
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
