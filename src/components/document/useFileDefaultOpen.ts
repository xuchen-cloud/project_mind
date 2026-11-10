import { useLayoutEffect, useRef } from "react";
import { fileOwnerScope } from "../../lib/file-types";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { projectFileApi } from "../../services/projectFileApi";

/** Capture the menu's binding; native opening resolves the current original by
 * File identity and checks its actual owner, path, existence and physical bytes. */
export function useFileDefaultOpen(workspaceRoot: string, projectId: number | null) {
  const epoch = useRef(0);
  useLayoutEffect(() => {
    epoch.current++;
    return () => { epoch.current++; };
  }, [workspaceRoot, projectId]);

  return (fileId: number) => {
    const generation = epoch.current;
    // A dismissed menu must not leave an unhandled binding-read rejection.
    const binding = recordDocumentApi.bindingGet(workspaceRoot).then(
      value => ({ value }), error => ({ error }),
    );
    return async () => {
      try {
        const result = await binding;
        if (generation !== epoch.current) return;
        if ("error" in result) throw result.error;
        await projectFileApi.openLocal(result.value, {
          workspaceId: result.value.workspaceId, scope: fileOwnerScope(projectId), kind: "file", id: String(fileId),
        });
      } catch (error) {
        if (generation === epoch.current) throw error;
      }
    };
  };
}
