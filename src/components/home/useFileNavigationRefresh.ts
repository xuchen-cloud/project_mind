import { matchesDirectoryQueryBinding } from "../../lib/project-directory-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ProjectSidebarDocumentItem } from "../layout/ProjectSidebar";
import { projectDirectoryApi } from "../../services/projectDirectoryApi";
import { recordDocumentApi } from "../../services/recordDocumentApi";
import { desktopApi } from "../../services/desktopApi";
import { queryKeys } from "../../lib/queryKeys";
import { getErrorMessage } from "../../lib/errors";
import type { AgentWorkspaceBinding } from "../../lib/agent-types";

/** Navigation-only presence checks: never resolve, delete or close a File. */
export function useFileNavigationRefresh({ projectId, rootPath, workspaceRoot, enabled, documents }: {
  projectId: number | null; rootPath: string; workspaceRoot?: string; enabled: boolean;
  documents: ProjectSidebarDocumentItem[];
}) {
  const client = useQueryClient();
  const scope = JSON.stringify([workspaceRoot, rootPath, projectId]);
  const generation = useRef(0);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const [presence, setPresence] = useState<{ scope: string; binding?: string; paths: Map<string, { present: boolean; health: ProjectSidebarDocumentItem["health"] }> }>({ scope, paths: new Map() });
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const flight = useRef<Promise<void> | undefined>(undefined);
  const pending = useRef<Set<string> | null | undefined>(undefined);
  const observedBinding = useRef<{ scope: string; value: AgentWorkspaceBinding } | undefined>(undefined);
  const [boundWorkspace, setBoundWorkspace] = useState<typeof observedBinding.current>();
  const acceptBinding = (value: AgentWorkspaceBinding) => {
    const previous = observedBinding.current;
    const next = previous?.scope === scope && previous.value.workspaceId === value.workspaceId && previous.value.generation === value.generation
      ? previous : { scope, value };
    observedBinding.current = next;
    setBoundWorkspace(next);
    const bindingKey = JSON.stringify([value.workspaceId, value.generation]);
    setPresence(previous => previous.scope === scope && previous.binding === bindingKey
      ? previous : { scope, binding: bindingKey, paths: new Map() });
  };
  useLayoutEffect(() => {
    observedBinding.current = undefined;
    setBoundWorkspace(undefined);
    setPresence({ scope, paths: new Map() });
  }, [scope]);
  useLayoutEffect(() => {
    generation.current++;
    flight.current = undefined;
    pending.current = undefined;
    setError("");
    setRefreshing(false);
    return () => { generation.current++; };
  }, [scope, enabled]);

  const refresh = (dirtyPaths?: string[] | null) => {
    if (!enabled) return Promise.resolve();
    if (dirtyPaths?.length === 0) return Promise.resolve();
    pending.current = pending.current === null || dirtyPaths == null ? null : new Set([...(pending.current ?? []), ...dirtyPaths]);
    if (flight.current) return flight.current;
    const epoch = generation.current;
    const current = () => epoch === generation.current;
    setRefreshing(true);
    setError("");
    const run = async () => {
      while (pending.current !== undefined && current()) {
        const dirty = pending.current;
        pending.current = undefined;
        setError("");
        try {
          const binding = workspaceRoot ? await recordDocumentApi.bindingGet(workspaceRoot) : undefined;
          if (!current()) return;
          if (binding) acceptBinding(binding);
          const bindingKey = binding ? JSON.stringify([binding.workspaceId, binding.generation]) : undefined;
          const prefix = ["project-directory", rootPath, projectId];
          const pageKey = projectId === null ? queryKeys.workspacePage : queryKeys.projectPage(projectId);
          const matchesBinding = (key: readonly unknown[]) => matchesDirectoryQueryBinding(key, workspaceRoot, binding);
          // Tree dirty hints already use ProjectDirectoryBrowser's shared queue.
          // Only an explicit refresh needs to reconcile every expanded branch.
          await Promise.allSettled([
            ...(dirty === null ? client.getQueryCache().findAll({ queryKey: prefix,
              predicate: query => matchesBinding(query.queryKey) }) : []),
            ...client.getQueryCache().findAll({ queryKey: pageKey }),
          ].filter(query => query.state.fetchStatus !== "idle").map(query => query.promise));
          if (!current()) return;
          await Promise.all([
            dirty === null ? client.invalidateQueries({ queryKey: prefix,
              predicate: query => matchesBinding(query.queryKey) }, { cancelRefetch: false, throwOnError: true }) : Promise.resolve(),
            client.invalidateQueries({ queryKey: pageKey }, { cancelRefetch: false, throwOnError: true }),
          ]);
          if (!current()) return;
          const root = rootPath.replaceAll("\\", "/").replace(/\/$/, "") + "/";
          const checked = documentsRef.current.flatMap(item => {
            const path = item.managedPath.replaceAll("\\", "/");
            if (!path.startsWith(root)) return [];
            const relative = path.slice(root.length);
            const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
            if (dirty !== null && ![...dirty].some(hint => hint === "" || hint === parent || parent.startsWith(`${hint}/`))) return [];
            return [{ id: item.id, relative, health: item.health }];
          });
          const paths = checked.map(item => item.relative);
          // Read only ancestors of registered Files. A failed enumeration is an
          // error, never evidence that its descendants have been deleted.
          const listings = new Map<string, Awaited<ReturnType<typeof projectDirectoryApi.list>>>();
          const directories = new Set([""]);
          for (const path of paths) {
            const parts = path.split("/");
            parts.pop();
            while (parts.length) { directories.add(parts.join("/")); parts.pop(); }
          }
          for (const directory of [...directories].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
            if (!current()) return;
            if (directory) {
              const parent = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
              if (!listings.get(parent)?.some(entry => entry.relativePath === directory && entry.kind === "directory")) continue;
            }
            const entries = await projectDirectoryApi.list(projectId, directory);
            if (!current()) return;
            listings.set(directory, entries);
          }
          if (binding && workspaceRoot) {
            const after = await recordDocumentApi.bindingGet(workspaceRoot);
            if (binding.workspaceId !== after.workspaceId || binding.generation !== after.generation) throw new Error("工作区已切换，请重试刷新。");
          }
          if (!current()) return;
          setPresence(previous => {
            const next = new Map(previous.scope === scope && previous.binding === bindingKey ? previous.paths : []);
            for (const { id, relative, health } of checked) {
              const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
              next.set(`${id}:${root}${relative}`, { health, present: !!listings.get(parent)?.some(entry => entry.relativePath === relative && entry.kind === "file") });
            }
            return { scope, binding: bindingKey, paths: next };
          });
        } catch (reason) {
          if (current()) setError(getErrorMessage(reason, "无法刷新文件列表"));
        }
      }
    };
    const promise = run().finally(() => {
      if (current()) { flight.current = undefined; setRefreshing(false); }
    });
    flight.current = promise;
    return promise;
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!enabled || !workspaceRoot || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    const epoch = generation.current;
    const current = () => !disposed && generation.current === epoch;
    const early: { binding: AgentWorkspaceBinding; projectId: number | null; relativePaths?: string[] | null }[] = [];
    let unlisten: (() => void) | undefined;
    const changed = (hint: typeof early[number]) => {
      if (!current() || hint.projectId !== projectId || hint.relativePaths?.length === 0) return;
      const binding = observedBinding.current?.scope === scope ? observedBinding.current.value : undefined;
      if (!binding) { early.push(hint); return; }
      if (hint.binding.workspaceId === binding.workspaceId && hint.binding.generation === binding.generation) void refreshRef.current(hint.relativePaths);
    };
    void (async () => {
      unlisten = await desktopApi.listenEvent("mind:project-directory-dirty", changed);
      if (!current()) { unlisten(); return; }
      const previous = observedBinding.current;
      const binding = await recordDocumentApi.bindingGet(workspaceRoot);
      if (current()) {
        // Listener setup establishes event ownership only. It must not bypass
        // the discovery panel's pending/error state or activate hidden reads.
        if (observedBinding.current === previous) observedBinding.current = { scope, value: binding };
        for (const hint of early) changed(hint);
      }
    })().catch(reason => { if (current()) setError(getErrorMessage(reason, "无法监听文件变化")); });
    return () => { disposed = true; unlisten?.(); };
  }, [enabled, scope]);
  const visibleDocuments = documents.filter(item => {
    const known = presence.scope === scope ? presence.paths.get(`${item.id}:${item.managedPath.replaceAll("\\", "/")}`) : undefined;
    return known && known.health === item.health ? known.present : item.health !== "missing";
  });
  return { refresh, refreshing, error, visibleDocuments, binding: boundWorkspace?.scope === scope ? boundWorkspace.value : undefined };
}
