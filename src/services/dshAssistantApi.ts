import { desktopApi } from "./desktopApi";

const starts = new Map<number | null, { key: string; promise: Promise<void> }>();
const runtimeTails = new Map<number | null, Promise<unknown>>();

function runtimeCommand<T>(command: string, args: Record<string, unknown> & { projectId: number | null }): Promise<T> {
  const { projectId } = args;
  const next = (runtimeTails.get(projectId) ?? Promise.resolve()).then(() => desktopApi.command<T>(command, args));
  const tail = next.catch(() => {});
  runtimeTails.set(projectId, tail);
  void tail.then(() => { if (runtimeTails.get(projectId) === tail) runtimeTails.delete(projectId); });
  return next;
}

// Window-local queues per scope; native owns each scope runtime, origin and credentials.
export const dshAssistantApi = {
  start(syncKey: string, projectId: number | null): Promise<void> {
    const key = JSON.stringify([syncKey, projectId]);
    const latestStart = starts.get(projectId);
    if (latestStart?.key === key) return latestStart.promise;
    const next = runtimeCommand<void>("dsh_assistant_start", { projectId });
    starts.set(projectId, { key, promise: next });
    const clear = () => { if (starts.get(projectId)?.promise === next) starts.delete(projectId); };
    void next.then(clear, clear);
    return next;
  },
  sessions(projectId: number | null): Promise<{ id: string; title: string; running: boolean }[]> {
    return runtimeCommand("dsh_assistant_sessions", { projectId });
  },
  selectSession(sessionId: string | null, projectId: number | null): Promise<string> {
    return runtimeCommand("dsh_assistant_select_session", { projectId, sessionId });
  },
  deleteSession(sessionId: string, projectId: number | null): Promise<void> {
    return runtimeCommand("dsh_assistant_delete_session", { projectId, sessionId });
  },
};
