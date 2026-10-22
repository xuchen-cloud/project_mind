import React, { createContext, useContext } from 'react';

// Host contribution to the official completed-turn slot. The SDK supplies both
// identities; inherited/fork history is deliberately queried in the viewed Session.
export const MemoryAdoptionRenderer = createContext(null);
export function MemoryAdoptionTail({ sessionId, turn }) {
  const render = useContext(MemoryAdoptionRenderer);
  return render?.({ sessionId, turn: turn.turn }) ?? null;
}
