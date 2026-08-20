import { FileDown, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { desktopApi } from "../../services/desktopApi";
import { ActionContextMenu, IconButton } from "../../ui/components";
import { RecordExportDialog } from "./RecordExportDialog";
import type { RecordExportRequest, RecordExportResult } from "./recordExport";
import { chooseRecordExportTarget } from "./recordExportTarget";

export function RecordExportAction({
  title,
  getCommittedHtml,
  exportTo,
}: {
  title: string;
  getCommittedHtml: () => string;
  exportTo: (request: RecordExportRequest) => Promise<RecordExportResult>;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const hasImages = /<img\b/iu.test(getCommittedHtml());

  return (
    <>
      <IconButton type="button" size="sm" variant="ghost" aria-label="记录更多操作"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right, y: rect.bottom + 4 });
        }}>
        <MoreHorizontal size={16} />
      </IconButton>
      {typeof document !== "undefined"
        ? createPortal(
            <>
              {menu ? (
                <ActionContextMenu x={menu.x} y={menu.y} ariaLabel="记录更多操作" onClose={() => setMenu(null)}
                  actions={[{ label: "导出…", icon: FileDown, onSelect: () => { setMenu(null); setOpen(true); } }]} />
              ) : null}
              <RecordExportDialog
                open={open}
                hasImages={hasImages}
                onClose={() => setOpen(false)}
                chooseTarget={(format, includeImages) => chooseRecordExportTarget({ title, format, includeImages, hasImages })}
                exportTo={exportTo}
                onOpenFile={(path) => desktopApi.openFile(path)}
                onRevealFile={(path) => desktopApi.revealPath(path)}
              />
            </>,
            document.body,
          )
        : null}
    </>
  );
}
