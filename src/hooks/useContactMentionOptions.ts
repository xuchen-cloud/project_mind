import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { buildContactMentionTarget, type ContactMentionTarget } from "../lib/contactMentions";
import { deriveContactPinyin } from "../lib/pinyin";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";
import { useUiStore } from "../state/ui-store";
import type { RichEditorContactMentionOptions } from "../components/rich-editor";

/**
 * Shared `contactMentions` options for RichEditor / Todo composers.
 *
 * - First-time mentions can create a contact in place (deriving searchable
 *   pinyin on the frontend, since the backend keeps only ASCII fallbacks).
 * - Opening a mention routes to the contacts directory (settings) for now;
 *   there is no dedicated per-contact page yet.
 */
export function useContactMentionOptions(): RichEditorContactMentionOptions {
  const queryClient = useQueryClient();
  const { pushToast } = useFeedbackStore();
  const openSettings = useUiStore((state) => state.openSettings);

  const onCreateContact = useCallback(
    async (name: string): Promise<ContactMentionTarget | null> => {
      const trimmed = name.trim();
      if (!trimmed) {
        return null;
      }

      try {
        const pinyin = deriveContactPinyin(trimmed);
        const contact = await projectMindApi.contactUpsert({
          name: trimmed,
          pinyinFull: pinyin.pinyinFull,
          pinyinAbbr: pinyin.pinyinAbbr,
        });
        await queryClient.invalidateQueries({ queryKey: ["contacts"] });
        return buildContactMentionTarget(contact);
      } catch (error) {
        pushToast({
          tone: "error",
          title: "创建联系人失败",
          detail: String(error),
        });
        return null;
      }
    },
    [pushToast, queryClient],
  );

  const onOpenContact = useCallback(
    (_mention: ContactMentionTarget): boolean => {
      openSettings("contacts");
      return true;
    },
    [openSettings],
  );

  return useMemo(
    () => ({ onCreateContact, onOpenContact }),
    [onCreateContact, onOpenContact],
  );
}
