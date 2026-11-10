# Assistant summaries, candidates and scratch — #305

## Scope

G06/S1/S2, G10 and G11 from the 2026-11-10 review handoff, starting at `fe9fe9c188f05c23bae369074446e38c0859a0c8`. Only `assistant.patch` was imported. The original checkout and its staged/source changes were not modified.

## Implementation

- `mind/session/summaries` returns a scoped revision and metadata rows. The native list route shares this path. Ordinary admission retains the shared catalog; external watchers and the bounded reconciliation still refresh physical revisions. Lists do not request full Session projections.
- A rebuildable, size-bounded title cache persists header/revision-bound hints. Missing or changed legacy hints return immediately, then a single background worker repairs them through DSH's public logical title query. A correction becomes visible on a later read. This background migration can read a cold log; it is not a foreground list or Workspace-ready prerequisite.
- `--history-only` shares one Workspace host across scopes without a model/key, native CLI, bundled skill preparation, source/Office services or task restoration. An executing scope explicitly upgrades through the original readiness path. Native summary reads clone authenticated transport state, perform catalog I/O outside the global runtime mutex, then recheck Workspace binding, context and host generation. Host preparation privately owns the runtime pool and publishes through a cancellation gate; status uses a bounded snapshot rather than waiting on readiness. Shutdown holds a transition guard, including preparation that has not subscribed yet. Enabled scheduled tasks explicitly upgrade an idle history host to execution readiness; a history host alone never suppresses task restoration.
- Query keys include Workspace ID, generation and scope. Sidebars and bounded idle/hover prefetch share 15-second stale time and in-flight work. Mutations reconcile an older read; Workspace close/reopen removes the agent namespace and cancels scheduled prefetch.
- `@` and `/` candidate material uses an opaque theme layer and system colors in forced-color mode. Scroll masks now cover only the scroll viewport, follow remaining distance in both directions, and remeasure content/viewport resizing. Source hashes and local changes are recorded in provenance.
- The existing scratch section remains a model instruction, not a file interceptor. Actual tool cwd is preserved. Intermediate files use `<session-workdir>/.mind-tmp/<session-id>/`; requested final deliverables use normal directories.

## Evidence and limits

- Foreground summary benchmark: body size 32,768 → 2,129,920 bytes; forced metadata refresh reads 16,591 bytes in both cases. First B and A revisit add zero filesystem bytes; cold read handles/projection calls are 0/0. The isolated fixture measures this boundary, not production p95 or Windows latency.
- Real DSH runtime and actual shell with deterministic local SSE provider exercised Project/Workspace × new/restored Sessions. All four wrote scratch intermediates and normal-directory deliverables. Providerless history reopening preserved the sessions (517 ms Project / 519 ms Workspace with pinned Node 24.21.0 in the final sample). This verifies integration, not a guarantee that every external model follows the policy.
- Real metadata HTTP sample, macOS / pinned Node 24.21.0 / two Sessions: host ready 508.09 ms; first A 5.13 ms; register B 1.40 ms; first B 1.22 ms; revisit A 0.99 ms; backend focus-equivalent read 0.96 ms; concurrent A/B/A 1.55/1.69/1.82 ms. One host PID remained throughout and the provider received zero requests. These are single backend samples, not frontend first-row visibility, native lock-wait measurements, Windows or p95.
- Frontend affected-page regression passed 139 tests in 7 files. After the review correction, the 4 changed query/API/sidebar test files passed 57 tests again. Root TypeScript passed. Assistant package verification combines the full run (260 pass / 27 fail / 2 platform skips) and a corrected failed-range rerun (28 pass / 2 skips); the failures were the obsolete prompt matcher and a missing checksum-verified staged Node in the isolated worktree. There are no remaining unit failures; PowerShell cases remain skipped on macOS.
- Native assistant regression passed 61 tests with 3 explicit acceptance/resource ignores. The final history delta compiled and passed both transport and lifecycle tests, including nonblocking status and shutdown before cancellation subscription. The three real-runtime integration tests passed without skips.
- Final Chrome validation passed all 18 scenarios across light, dark and forced colors, including selected descendant backgrounds, drill hints/hover, pointer selection, continuous bidirectional masks and content/viewport resizing. Screenshots were inspected. DSH UI integrity passed 5 tests; UI standards, DSH runtime check and UI browser closure passed. Host production Vite build passed after supplying the isolated worktree's missing renderer distribution caches. Existing Office/Markdown distribution caches were reused, with PPTX/XLSX manifest hashes in the local cache receipt; this host bundle check does not validate Office changes.
- Windows WebView2 and Windows contrast-theme acceptance requires a Windows host, the rebuilt application/runtime, an isolated Workspace, and light/dark/contrast screenshots with pointer, keyboard and scroll checks. macOS Chrome emulation is separate evidence. This remains a merge blocker until actual target-platform acceptance is recorded.

## Reproduction

Run resource-heavy checks through the review wave's shared build lock. Keep the application closed for unit/build checks.

- Assistant package: `node --test --test-concurrency=1 packages/dsh-assistant/test/*.test.mjs` using the staged, checksum-verified Node runtime for process-ownership tests.
- Runtime integration: `node --test --test-name-pattern 'history-only runtime|scratch policy reaches|summary latency' packages/dsh-assistant/test/runtime.integration.mjs`.
- Frontend regression: `npm run test:unit -- src/components/home/ProjectSidebarSessions.test.tsx src/lib/session-summaries.test.ts src/lib/project-prefetch.test.ts src/services/dshAssistantApi.test.ts --maxWorkers=1`.
- Native: `cargo test --manifest-path src-tauri/Cargo.toml --lib dsh_assistant --quiet -- --test-threads=1`; the history filter exercises providerless transport, nonblocking status, publication waiting and shutdown before cancellation subscription.
- Menu: set `PLAYWRIGHT_CLI` to the installed Playwright CLI entry and run `node packages/dsh-ui/trigger-menu.browser.mjs`. This uses the actual vendored menu and host styles, checks system Highlight/HighlightText, pointer selection and scroll/resize behavior, and writes screenshots under `output/playwright/assistant-menu`.
- Packaging: TypeScript, root Vite build, `npm run check:dsh`, DSH UI `check:adapters`/`test:integrity`, and `npm run check:ui-standards`.

Generated logs and screenshots are local evidence, not application resources. Windows WebView2 acceptance must be attached to #305 before the integration chat marks the scoped work ready to merge or closes the issue.
