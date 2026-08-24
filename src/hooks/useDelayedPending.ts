import { useEffect, useState } from "react";

export const COLD_PENDING_DELAY_MS = 120;

export function useDelayedPending(
  pending: boolean,
  delayMs = COLD_PENDING_DELAY_MS,
) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!pending) {
      setVisible(false);
      return;
    }

    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, pending]);

  return pending && visible;
}
