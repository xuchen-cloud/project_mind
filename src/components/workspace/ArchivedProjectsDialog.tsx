import { lazy, Suspense, useState } from "react";

import type { ArchivedProjectsDialogProps } from "./ArchivedProjectsDialogContent";

const DialogContent = lazy(() => import("./ArchivedProjectsDialogContent").then(module => ({ default: module.ArchivedProjectsDialogContent })));

export function ArchivedProjectsDialog(props: ArchivedProjectsDialogProps) {
  // Load on first use, then retain the dialog so its closing transition can finish.
  const [hasOpened, setHasOpened] = useState(props.open);
  if (props.open && !hasOpened) setHasOpened(true);
  return hasOpened ? <Suspense fallback={null}><DialogContent {...props} /></Suspense> : null;
}
