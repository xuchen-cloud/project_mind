import { useMemo, useRef } from "react";
import type { AgentWorkspaceBinding } from "../lib/agent-types";
import type { RecordTarget } from "../lib/record-document-types";
import type { RecordCutTransport } from "../components/rich-editor/extensions/StableRecordBlocks";
import { recordDocumentApi } from "../services/recordDocumentApi";

export function useRecordClipboard(binding: AgentWorkspaceBinding | null, target: RecordTarget | null): RecordCutTransport {
  const current = useRef({ binding, target });
  current.current = { binding, target };
  return useMemo(() => ({
    async registerCut(token: string) {
      const { binding, target } = current.current;
      if (!binding || !target) return;
      await recordDocumentApi.cutRegister(binding, target, token);
    },
    async claimCut(token: string) {
      const { binding, target } = current.current;
      return binding && target ? recordDocumentApi.cutClaim(binding, target, token) : false;
    },
  }), []);
}
