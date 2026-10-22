# Record / File guide

Load this branch only for Record or File work. Discover the relevant subcommand help and exact method schema before constructing input; the installed CLI owns field names and limits.

## Read the current content

- **Record:** `record get` for bounded body pages; `record blocks get` for canonical block IDs/hashes before a patch; `record versions` for historical evidence. Preserve returned revision/cursor when continuing pages. `reference list` follows incoming/outgoing native references.
- **File:** use `file source read`, `source.read` or File version methods as appropriate. To edit a File, obtain the exact current bytes, version number and full `sha256:…` hash; keep the same File ID for subsequent edits.

Read all content needed to preserve the requested edit, following returned cursors. A bounded excerpt is not the whole document. Pending editor previews are not Committed Content; an editor-busy/pending-review failure requires resolution before a native Record commit.

## Record create / patch

For a new Record, prepare UTF-8 Markdown, preview, then commit the intended payload with a stable request ID. `$PROJECT_ID` comes from the binding/authorized reads; for Workspace Records replace `--project "$PROJECT_ID"` with `--workspace-scope`:

```sh
mind record create --title 'Release notes' --body-file note.md --project "$PROJECT_ID" --dry-run --workspace "$WORKSPACE" --connection "$CONNECTION" --json
mind record create --title 'Release notes' --body-file note.md --project "$PROJECT_ID" --request-id "$CREATE_REQUEST_ID" --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

Existing Record edits use `record.patch`'s native RecordPatch shape, including current `baseRevision`, canonical block identities/hashes and its stable `requestId`. `--patch-file` accepts that JSON directly:

```sh
mind record patch --patch-file patch.json --dry-run --workspace "$WORKSPACE" --connection "$CONNECTION" --json
mind record patch --patch-file patch.json --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

Use stdin (`--input-file -` / `--patch-file -`) for small transient JSON inputs in managed directories. Record create/patch dry-run saves no version or receipt and may omit the mutation request ID. Preview does not reserve the baseline: commit checks it again. Discover schema limits before preparing a large body.

## File create / replace

Files belong to Projects. `file create --name NAME --body-file PATH --project ID` creates UTF-8 content. For full content replacement, preserve identity and use the current File version/hash:

```sh
mind file update --id "$FILE_ID" --source-file replacement.bin --project "$PROJECT_ID" --expected-version "$FILE_VERSION" --expected-hash "$FILE_HASH" --request-id "$UPDATE_REQUEST_ID" --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

Paths stay local; the CLI stages bytes before committing. Explicit staged uploads use `file.content.*` and `file.update` schemas; a completed upload stage is not a committed File version.

If `file.patch` rejects a Project directory File with “Directory File updates must use the directory service”, use the existing `file update` staged full replacement: read its exact current bytes, apply the requested edit locally, retain its ID and submit with current version/hash. This is a storage-mode branch, not a permission workaround; other permission errors still require authorized resolution.

Finish with the [receipt and readback criteria](../SKILL.md#5-verify-and-report). Use the shared [recovery process](../SKILL.md#recover-from-the-actual-outcome) for conflicts, uncertain outcomes and requested undo/restoration.
