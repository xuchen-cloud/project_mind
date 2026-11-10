import { desktopApi } from "../services/desktopApi";
import type { AgentObjectRef } from "./agent-types";
import type { ContentOwnerMoveRelease } from "./project-content-lifecycle";

export interface ContentOwnerMoved extends ContentOwnerMoveRelease {
  target: AgentObjectRef;
  oldSessionsClosed: boolean;
}

export async function subscribeContentOwnerMoveEvents(handlers: {
  moved: (event: ContentOwnerMoved) => void;
  released: (event: ContentOwnerMoveRelease) => void;
}) {
  const stopMoved = await desktopApi.listenEvent("content:owner-moved", handlers.moved);
  try {
    const stopReleased = await desktopApi.listenEvent("content:owner-move-released", handlers.released);
    return () => { stopMoved(); stopReleased(); };
  } catch (failure) { stopMoved(); throw failure; }
}
