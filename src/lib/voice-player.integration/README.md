# VoicePlayer: real WebKit + Tauri asset Range integration

Run explicitly, without opening an application window:

```sh
node src/lib/voice-player.integration/run.mjs
```

This does **not** join Vitest discovery, start Vite/Tauri dev, rebuild the application, change a lockfile, or touch other packages. It uses the repository's existing Playwright WebKit installation and cached native **test** artifacts. Missing artifacts fail explicitly; the runner never silently replaces the handler or installs dependencies. The verified environment is macOS, Node 26, Tauri 2.10.3, Playwright WebKit 26.5.

Optional environment paths:

- `VOICE_TAURI_DEPS`: cached `src-tauri/target/debug/deps` directory.
- `VOICE_PLAYWRIGHT_MODULE`: existing Playwright `index.mjs`; defaults to the Office package's installed runner, read only.
- `VOICE_RANGE_OUTPUT`: evidence directory; defaults to ignored `output/playwright/voice-range`.

## What executes

1. Select a cached Tauri artifact with `test`, `protocol-asset`, and `webview-data-url`. Resolve its **exact dependency fingerprints**, including u64 hashes without JavaScript precision loss, rather than mixing similarly named cached crates.
2. `rustc` compiles only `asset-server.rs`. It directly includes the installed **unmodified** `tauri/src/protocol/asset.rs` and exposes its private `get_response` inside that module. The private `safe_block_on` function is extracted verbatim from the same installed Tauri source. Source SHA-256 and selected artifact paths are recorded.
3. Tauri `MockRuntime` supplies an App/Scope container only; no Window/Webview or event loop is built. The real `Scope`, `SafePathBuf`, Tokio file I/O, Range parser, 1000 KiB cap, status, headers and response body execute. Each generated hidden audio file is individually authorized with real `Scope.allow_file`; an unrelated file remains denied.
4. A minimal loopback HTTP transport forwards requests to that handler and forwards its response. It does not implement its own Range parser, body slicing, decoding, or scope policy.
5. The unchanged production `voice-player.ts` is transpiled alone with installed Vite/Oxc. Real headless WebKit executes native fetch, `OfflineAudioContext.decodeAudioData`, `AudioBuffer`, `AudioContext` and `AudioBufferSourceNode`. Forwarding observers count actual calls and invoke the original native methods.
6. A real AnalyserNode measures rendered audio before a real zero-gain node. Test output is silent at the device, while the graph and audio clock run normally.

Temporary PCM fixtures and the native helper are removed on success/failure. Browser/helper processes are closed. The generated one-hour 48 kHz float32 originals are sparse: unused regions are valid silence; the first two windows and the 3015-second seek region contain generated PCM. This saves disk without substituting fetch or decoded buffers.

## Assertions and evidence

`result.json` records handler requests, status, range, Content-Range and body length; browser version; source hashes; native dependency paths; real decode concurrency; scheduled source clocks; AudioBuffer usage; RMS samples; and teardown usage.

The verified run checks:

- Actual 206 with `bytes 0-43/691200044`, a capped response of 1,024,000 bytes, 403 for a file outside Scope, and 416 for an unsatisfiable Range.
- One-hour dual original playback: four real buffers on first load and four additional buffers after seeking to 3015 seconds. Both tracks share a start clock and sample offset. Running seek resumes playback with the real audio clock.
- Append during 1.5× playback: decode only two new files; preserve position/speed and existing source nodes; schedule both appended tracks on the same clock at the speed-adjusted boundary.
- At least five real rendered audio samples across the appended boundary, each RMS > 0.005; continue playing after seek; dispose to zero retained buffers/sources.
- Real decode concurrency <= 2 and no playback/page errors.

A first attempt exposed an invalid test assumption: a real AudioContext can advance one render quantum before scheduling. Track offset is therefore checked for equality between tracks and within 100 ms of the intended seek offset, rather than asserting a frozen mock clock. The scheduled append boundary accounts for the actual initial source offset. No production code was changed for this adjustment.

## Difference from a Tauri application window

This proves real WebKit fetch/decoding/playback against Tauri's actual response implementation. It does **not** execute macOS WKURLSchemeHandler, Tauri's `asset://` native-to-WebView response bridge, command IPC/ACL, `voice_playback_get` file authorization wiring, or real speaker/microphone synchronization. Same-origin HTTP also does not prove WebKit's custom-protocol CORS behavior. The mock App is not a mock Range handler.

Those remaining bridge/permission checks require an actual Tauri Webview. Minimum consolidated device procedure (the harness itself does not open it):

1. Start the approved app once with watching disabled; open an existing Voice Record so `voice_playback_get` grants its hidden original paths. Use a >60-second legacy original for the Range path.
2. In that Webview's DevTools, use a returned original file path and the actual bridge:

   ```js
   const audioPath = /* an original path returned by this record's playback manifest */;
   const assetUrl = window.__TAURI_INTERNALS__.convertFileSrc(audioPath, 'asset');
   for (const range of ['bytes=0-43', 'bytes=44-2097195']) {
     const response = await fetch(assetUrl, { headers: { Range: range } });
     console.log(range, response.status, response.headers.get('Content-Range'), (await response.arrayBuffer()).byteLength);
   }
   ```

   Expect 206, exact header range for the first request, and Tauri's 1,024,000-byte cap for the second. Check a path not authorized by the Record remains denied; do not broaden asset scope.
3. Play, seek into a distant available window (3015 seconds for a one-hour original), append/refresh saved chunks, then close playback. Confirm continuous two-source sound, preserved speed/position, bounded window reads, and cancelled loads.

A native bridge failure remains a real defect; it must not be relabeled as covered by this HTTP transport test.
