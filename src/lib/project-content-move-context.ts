import { createContext } from "react";

/** A source page must not submit another leave snapshot after a confirmed move. */
export const ProjectContentMoveContext = createContext<{ committed: boolean; nativeSessionsClosed?: boolean } | null>(null);
