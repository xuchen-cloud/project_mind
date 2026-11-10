/** Wait before document timing; hidden WKWebViews can suspend both RAF and timers. */
export async function waitForNativeVisibility(doc: Document, timeoutMs = 120000) {
  const initialVisibility = doc.visibilityState;
  const started = performance.now();
  if (initialVisibility !== 'visible') {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        doc.removeEventListener('visibilitychange', changed);
        if (timer !== undefined) clearTimeout(timer);
      };
      const changed = () => {
        if (settled || doc.visibilityState !== 'visible') return;
        settled = true;
        cleanup();
        resolve();
      };
      doc.addEventListener('visibilitychange', changed);
      // Do not miss visibility changing between the initial read and subscription.
      changed();
      if (settled) return;
      timer = setTimeout(() => {
        settled = true;
        cleanup();
        reject(Error(`Native window did not become visible before measurement (${timeoutMs}ms)`));
      }, timeoutMs);
    });
  }
  return { initialVisibility, visibility: doc.visibilityState, waitedMs: performance.now() - started };
}
