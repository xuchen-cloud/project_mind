import { resolveActivityTitle } from "../../lib/constants";
import type { ActivityCardData } from "../../lib/types";
import { Button, Dialog } from "../../ui/components";

export function ActivityDeleteDialog({
  activity,
  open,
  busy,
  onClose,
  onConfirm,
}: {
  activity: ActivityCardData;
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      title="删除 Activity"
      description="删除后会移除当前 activity 及其关联内容，请确认后继续。"
      onClose={onClose}
      widthClassName="max-w-lg"
      footer={
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "删除中..." : "确认删除"}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-body text-text">
        <p>
          将删除{" "}
          <strong>{resolveActivityTitle(activity.title, activity.id)}</strong>。
        </p>
        <p className="text-text-muted">
          对应的活动记录、结论、Todo、文件都会删除，活动文件夹和嵌入图片也会一并清理。
        </p>
        <ul className="grid gap-1 text-text-muted">
          <li>活动记录：{activity.notes.length} 条</li>
          <li>结论：{activity.conclusions.length} 条</li>
          <li>Todo：{activity.todos.length} 条</li>
          <li>文件：{activity.documents.length} 个</li>
        </ul>
      </div>
    </Dialog>
  );
}
