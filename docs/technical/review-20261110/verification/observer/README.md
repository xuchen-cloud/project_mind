# G12 native observer verification

Issue #307. Production observer source: `2cab61974ff99be2f83326dcd6e2ae6862eb78f4`; final test-only correction: `16f2278fd06054c809c7848e5c993eecd4a50183`.

- Actual boundary tests: 46 passed, 0 failed. The first visibility change left a missing VM binding and4 failures; that review finding was fixed before this final run. Both review axes have0 remaining findings.
- Root `tsc --noEmit`, `OFFICE_PERFORMANCE=1 vite build`, and native `cargo build --features office-performance,tauri/custom-protocol` passed under the shared build lock. Binary path/hash is in build-provenance.json.
- Fresh isolated Workspace/app-data, real native ProjectFileContent shell, DOCX and Markdown simple fixtures: all7 acceptance rows per format passed, no errors. Both report actual visibility=visible. The flow includes editing/autosave with working revision/hash, close/native working readback, separate explicit archive, reopen, immutable history and stale-CAS rejection.
- DOCX cold-open1778ms exceeds the1000ms single-sample budget, so its report correctly says over_budget. Markdown cold-open779ms. Neither sample is release/p95 evidence or full-app startup. Office renderer artifacts were reused from the prepared local baseline; this is observer protocol/persistence evidence, not acceptance of G04/G09 engine changes.
- Earlier hidden-window RAF failures and timeouts remain under output/g12-observer and output/g12-observer-round2; they are invalid performance samples. The round3 GUI queue was cancelled before launch while locked, then rerun after the human confirmed unlock. No user Workspace or app-data was opened.
- Windows, Linux, full-size/repetition matrices and release performance remain outside this Issue and unverified here.

Reproduction: prepare fixtures with `node scripts/office-performance/fixtures.mjs <fixtures>`, run native-run.mjs with `--setup=1` against unique Workspace/app-data, copy fixture samples into its returned project root, then serially run `--format=docx|md --sample=simple --acceptance=1 --visible=1 --timeout=180000`. Each command must run through the review-wide build lock. Raw reports preserve all command/working receipts and measurement details; artifact-manifest.json records hashes.
