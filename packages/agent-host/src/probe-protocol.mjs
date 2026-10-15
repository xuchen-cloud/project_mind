// Acceptance-labelled wrapper over the production lifecycle.
import { createHostProtocol } from './host-protocol.mjs';
export function createProbeProtocol(options) { return createHostProtocol({ ...options, probe: true }); }
