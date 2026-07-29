import { useCallback } from "react";

import type { ContactMentionTarget } from "../lib/contactMentions";
import { useUiStore } from "../state/ui-store";

/**
 * Open a contact mention. There is no dedicated per-contact page yet, so this
 * routes to the contacts directory in settings. Returns true so the chip is
 * never marked broken.
 */
export function useContactMentionNavigation() {
  const openSettings = useUiStore((state) => state.openSettings);

  return useCallback(
    (_mention: ContactMentionTarget): boolean => {
      openSettings("contacts");
      return true;
    },
    [openSettings],
  );
}
