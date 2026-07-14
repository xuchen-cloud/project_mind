import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import type { InternalReferenceTarget } from "../lib/internalReferences";
import { desktopApi } from "../services/desktopApi";
import { projectMindApi } from "../services/projectMindApi";
import { useFeedbackStore } from "../state/feedback-store";

export function useInternalReferenceNavigation() {
  const navigate = useNavigate();
  const { pushToast } = useFeedbackStore();

  return useCallback(
    async (reference: InternalReferenceTarget) => {
      try {
        const resolved = await projectMindApi.internalReferenceResolve({
          kind: reference.refKind,
          id: reference.refId,
        });

        if (!resolved) {
          pushToast({
            tone: "error",
            title: "引用已失效",
            detail: "对应的记录可能已经被删除或移动。",
          });
          return false;
        }

        if (resolved.kind === "document") {
          if (!resolved.managedPath) {
            pushToast({
              tone: "error",
              title: "打开文件失败",
              detail: "文件引用缺少可用路径。",
            });
            return false;
          }

          await desktopApi.openFile(resolved.managedPath);
          return true;
        }

        navigate(resolved.route);
        return true;
      } catch {
        pushToast({
          tone: "error",
          title: "打开引用失败",
          detail: "请稍后重试。",
        });
        return false;
      }
    },
    [navigate, pushToast],
  );
}
