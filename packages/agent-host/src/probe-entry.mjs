// Explicit acceptance-only executable; it cannot enable an application capability.
import { runHostEntry } from './host-entry.mjs';
await runHostEntry({ probe: true });
