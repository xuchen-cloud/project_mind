import { FileDown } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";

import { desktopApi } from "../../services/desktopApi";
import { IconButton } from "../../ui/components";
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
  const hasImages = /<img\b/iu.test(getCommittedHtml());

  return (
    <>
      <IconButton type="button" size="sm" variant="ghost" aria-label="导出为" title="导出为…" onClick={() => setOpen(true)}>
        <FileDown size={16} />
      </IconButton>
      {typeof document !== "undefined"
        ? createPortal(
            <>
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
