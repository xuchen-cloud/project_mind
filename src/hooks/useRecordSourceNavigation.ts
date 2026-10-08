import { useCallback, useMemo, useState } from "react";
import { parseSourceNavigation, sourceBlockNavigationState } from "../lib/source-navigation";

export function useRecordSourceNavigation(params: URLSearchParams, visible: boolean,
  ready: boolean, currentRevision: number | null) {
  const query = params.toString();
  const request = useMemo(() => parseSourceNavigation(new URLSearchParams(query)), [query]);
  const state = useMemo(() => sourceBlockNavigationState(request, visible, ready, currentRevision),
    [request, visible, ready, currentRevision]);
  const [result, setResult] = useState<{ key: string; located: boolean } | null>(null);
  const onSourceBlockResult = useCallback((located: boolean) => {
    setResult({ key: request.key, located });
  }, [request.key]);
  const message = state.message ?? (visible && state.navigation && result?.key === request.key
    ? result.located ? "已定位引用段落。" : "引用段落已删除或变更，无法定位来源。" : null);
  return { ...request, navigation: state.navigation, onSourceBlockResult, message };
}
