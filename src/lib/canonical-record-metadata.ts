import type { RecordTarget } from "./record-document-types";
import { recordDocumentApi } from "../services/recordDocumentApi";

export async function renameCanonicalRecord(workspaceRoot: string, target: RecordTarget, title: string) {
  const binding = await recordDocumentApi.bindingGet(workspaceRoot);
  const metadata = await recordDocumentApi.metadataGet(binding,target);
  return recordDocumentApi.metadataUpdate(binding,{
    target, title: title.trim() || null, tagIds: metadata.tagIds, expectedRevision: metadata.revision,
  },crypto.randomUUID());
}
