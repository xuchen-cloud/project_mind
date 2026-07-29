import { Trash2 } from "lucide-react";

import { ActionContextMenu } from "./ActionContextMenu";

export function DeleteContextMenu({
  x,
  y,
  onDelete,
  onClose,
  ariaLabel = "删除菜单",
  deleteLabel = "删除",
  disabled = false,
}: {
  x: number;
  y: number;
  onDelete: () => void;
  onClose: () => void;
  ariaLabel?: string;
  deleteLabel?: string;
  disabled?: boolean;
}) {
  return (
    <ActionContextMenu
      x={x}
      y={y}
      ariaLabel={ariaLabel}
      onClose={onClose}
      actions={[
        {
          icon: Trash2,
          label: deleteLabel,
          disabled,
          tone: "danger",
          onSelect: onDelete,
        },
      ]}
    />
  );
}
