# Combined File-flow verification

Related Issues: #304 (G13–G15), #308 (integration), #300 (file navigation).

Product source `943b5ac` combines the reviewed File/Record/coordinator work with files final `3ef75da`. Harness `cc99b73` includes the opt-in page and ambient TypeScript declarations. The embedded debug macOS binary, independent harness revision and SHA are recorded in `build-provenance.json` and the run2 report. This is not a shipping/release or Windows result.

## Results

- Native targeted suites:112 passed,0failed,8ignored; actual native source/worker hashes unchanged during the run. The ignored tests are not passed evidence.
- Seven file navigation/frontend suites:204 passed. Conflicts retain both target-only move menus and multiselection controls; directory rows retain selection and native drop-target attributes.
- Strict root TypeScript passed. Harness initial TypeScript failed due omitted existing ambient declarations, then passed aftercc99b73. Collector tests2 and SQLite reader test1 passed.
- New fresh native run2:9/9 checks passed, visible main Webview, no runtime errors. Actual UI observation is recorded in `window-observation.md`.
- Run1 failed visible-window preflight while Mac was locked; preserved as a failed sample. It did not create a Workspace or mutate test content.
- Canonical Mermaid dependency integration at09f55ca:44 tests across4 files passed, including Workspace/Project HTML serialization, parser reopen, stable block IDs and Markdown export. Diagram SVG is mocked in the two canonical cases; this is not native database or real renderer evidence. The independent G16 visual results remain separate.
- App import cleanup1d1c8ce:67 tests across App and canonical Record creation/metadata passed, root TypeScript/UI standards/shipping Vite/bundle boundaries passed. Both helpers were already in App's eager graph through its static WorkspacePage/ProjectOverviewPage imports. The cleanup removes two ineffective-dynamic-import warnings without pulling a previously lazy module into that graph. Main bundle249KiB remains under250KiB. Existing third-party WaveDrom eval and vendor-size warnings remain visible.

## Native scope

The new runner exercises production ProjectContentWorkspace/ProjectFileContent/Markdown components, real IPC, native editor registration and read-only fixture SQLite. It verifies actual save-CAS failure preserves the source draft/Tab/session; commit failure releases the target; successful move saves only that File and closes its source Tab; unrelated dirty input is untouched; replacement retains the Tab and opens a new native session while preserving pending bytes as a version; version name/importance changes preserve content and session.

Only generated fixture inputs under a fresh temporary root are eligible for source Trash. No user Workspace, credentials, application data or originals are used. The runner exits0 after the owned window terminates. Baseline Office renderer artifacts in this build only resolve imports; they do not verify the new progressive Office engines.

## Review and remaining gates

Record, File and native adapter worker findings were closed at their recorded reviewed heads; directory guards7700470+b8e330b received independent Standards0/Spec0. Integration inspected the two file merge conflicts and exercised both behaviors with204 tests plus112 native tests. The helper keeps member ownership validation ahead of retained-resource protection and uses the same checks under the fresh exclusive-owner commit fence, including navigation Trash.

This report does not establish multi-window/multiple-target-instance GUI, Record GUI movement, Office active-cell behavior, OS keyboard/IME/drag hit testing, Windows, full startup, release timing or actual second-volume recovery. Windows is explicitly unavailable; Issue304 and other platform acceptance Issues remain OPEN. New Records/Office work outside these snapshots and the final pending-code warning audit are not certified by this report. No combined merge is asserted.
