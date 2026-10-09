# Pi message display subset

Vendored/adapted from `@earendil-works/pi-web-ui` **0.75.3**, npm `gitHead` **a7d8dd3d5db7d66aa5cc6886e32768b1196ce91f**. This is the legacy published web UI; it does not claim a matching UI for the current runtime SDK.

Source tarball: https://registry.npmjs.org/@earendil-works/pi-web-ui/-/pi-web-ui-0.75.3.tgz

Original source files: `src/components/MessageList.ts`, `Messages.ts`, `StreamingMessageContainer.ts`.

MIT license in [LICENSE](LICENSE), verified against the upstream commit's root [LICENSE](https://raw.githubusercontent.com/badlogic/pi-mono/a7d8dd3d5db7d66aa5cc6886e32768b1196ce91f/LICENSE). Copyright (c) 2025 Mario Zechner. Keep this notice and license when distributing these files. The identical full MIT text is also shipped in `public/licenses/pi-web-ui-0.75.3.txt`; `public/licenses/pi-message-lit-dependencies.txt` contains the actual lockfile-pinned Lit tree notices (lit, lit-html, lit-element, @lit/reactive-element, @lit-labs/ssr-dom-shim, @types/trusted-types). Vite copies both static files to dist/licenses.

## Preserved behavior

`MessageList` maps actual tool results by original call ID, preserves ordered user/assistant render items and uses Lit `repeat`. `Messages` preserves assistant content-block order, result/pending-call matching, and aborted-call dispatch. `StreamingMessageContainer` preserves batched animation-frame updates, cloning the pending message so nested mutations trigger rendering, and separates streaming content from stable messages.

## Local changes

- Use local display types rather than SDK/browser Agent imports. Replace decorators with Lit static reactive properties, without changing project compiler configuration. Prefix custom element names with `pm-pi-` to avoid global registry collisions. Use actual native message IDs for stable list keys.
- Remove browser attachments, artifact/database/provider interfaces, usage/cost UI and debug/code widgets. No browser Agent, IndexedDB, credential store or model client is imported. Only `lit@3.3.1` is added.
- Replace the eager upstream tools barrel with `tool-renderer.ts`: Chinese, low-emphasis, closed details; errors remain visible. An aborted call has an explicit stopped/incomplete presentation without constructing a fake error result.
- Replace mini-lit Markdown/Thinking leaves with safe `MarkdownBridge.tsx` + the existing AgentMarkdown React reader. No raw HTML mount, image resource, KaTeX or browser link navigation. Only HTTP(S) explicit clicks reach the desktop opener.
- Preserve every user text block, rather than selecting the first. Unknown real content is readable text. History is not silently truncated.
- Show actual standalone tool results when pagination omitted their original call, without inventing a tool call. Current streamed calls can pair their real results without a duplicate orphan row. Each actual result gets a React source portal in its own closed details, outside the raw tool disclosure, using existing source parsing/navigation and binding. Reading citations does not require opening technical arguments or result JSON.
- Reset/cancel the pending animation frame when clearing or setting an immediate message. Upstream's persistent `_immediateUpdate` flag could discard the next normal chunk after a clear; targeted tests cover those real sequences. Disconnect cancels pending updates.
- All message styling is scoped beneath `.pi-message-view`, using existing app tokens. No upstream global app.css, reset, theme or second design system is imported.

`AgentPiMessages` is the React/native DTO adapter. It groups adjacent actual run IDs, exposes `renderAfterRun` once per last visible run group, and inserts actual live text through the streaming component. `renderBeforeStream` supports an explicit ephemeral pending prompt owned by the host. It creates no persisted conversation entry or business receipt. Sources retain host React router/query context through portals.
