import type { AgentScope } from "./agent-types";

// Window-local notifications from the authoritative business-log consumer.
// These only expire search suggestions; native ownership checks still authorize use.
const listeners = new Set<(scope: AgentScope | null) => void>();

export function invalidateInternalReferenceSearch(scope: AgentScope | null) {
  for (const listener of listeners) listener(scope);
}

export function subscribeInternalReferenceInvalidation(listener: (scope: AgentScope | null) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
