import { desktopApi } from "./desktopApi";

let latestStart: { key: string; promise: Promise<void> } | undefined;
let runtimeTail: Promise<unknown> = Promise.resolve();

function runtimeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const next = runtimeTail.then(() => desktopApi.command<T>(command, args));
  runtimeTail = next.catch(() => {});
  return next;
}

// Window-local queue; native owns the shared runtime, origin and credentials.
export const dshAssistantApi = {
  start(syncKey: string, projectId: number): Promise<void> {
    const key = JSON.stringify([syncKey, projectId]);
    if (latestStart?.key === key) return latestStart.promise;
    const next = runtimeCommand<void>("dsh_assistant_start", { projectId });
    latestStart = { key, promise: next };
    const clear = () => { if (latestStart?.promise === next) latestStart = undefined; };
    void next.then(clear, clear);
    return next;
  },
  sessions(projectId: number): Promise<{ id: string; title: string; running: boolean }[]> {
    return runtimeCommand("dsh_assistant_sessions", { projectId });
  },
  selectSession(sessionId: string | null, projectId: number): Promise<string> {
    return runtimeCommand("dsh_assistant_select_session", { projectId, sessionId });
  },
  deleteSession(sessionId: string, projectId: number): Promise<void> {
    return runtimeCommand("dsh_assistant_delete_session", { projectId, sessionId });
  },
};
