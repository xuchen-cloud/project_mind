# Record / File guide

Load this branch only for Record or File work. Discover the relevant subcommand help and exact method schema before constructing input; the installed CLI owns field names and limits.

## Choose create or continue

Apply the shared [binding/authorization check](../SKILL.md#check-binding-and-authorization) and [write decision](../SKILL.md#4-apply-the-requested-change). Reuse already-read native references/content; when insufficient, follow relevant authorized source queries, references and necessary pages to establish the target. A bounded result cannot establish that the entire scope contains no related object.

- **Record:** append new facts or correct affected passages in the same Record when that is the user's intended information unit. Apply the requested edit to the current body and preserve unrelated content; native versions retain prior committed text. Create a new Record for independently useful information or an explicitly separate entry. A shared topic/title alone does not justify combining independent entries.
- **File:** continue edits, additions or replacements of the same managed material through its existing File ID, producing a new version. Create a File for an independent deliverable. A filename is neither object identity nor a ban on creating another File with that name; resolve the user's intended material and Workspace or Project scope using native evidence.

## List, count or batch-read

Use the [unified List guide](lists.md) for `record.list` and `file.list`, metadata/detail modes, ID batches, title/content substring queries, tags, counts and pagination examples. Voice Records are included in `record.list`, distinguished by `recordType`.

Record read DTOs now use `object`, matching File reads; `record` remains an input alias for compatibility. Record metadata includes title, tags, createdAt, updatedAt and nullable lastEditedAt (the committed body head time). Do not confuse modification time with the event date described in the body.

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

Files belong to a Workspace or one Project. They share the same import, version, editing and receipt pipeline. Workspace Files are managed under the Workspace `files` directory; they do not change the ownership of Project Files. `file create --name NAME --body-file PATH --project ID` creates UTF-8 content in a Project; use `--workspace-scope` for Workspace Files. Workspace authorization does not automatically include every Project. For full content replacement, preserve identity and use the current File version/hash:

```sh
mind file update --id "$FILE_ID" --source-file replacement.bin --project "$PROJECT_ID" --expected-version "$FILE_VERSION" --expected-hash "$FILE_HASH" --request-id "$UPDATE_REQUEST_ID" --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

For Workspace File replacement, use `--workspace-scope` instead of `--project "$PROJECT_ID"`; preserve the actual Workspace File object, ID, version and hash. Project-only callers cannot create or edit Workspace Files.

Paths stay local; the CLI stages bytes before committing. Explicit staged uploads use `file.content.*` and `file.update` schemas; a completed upload stage is not a committed File version.

If `file.patch` rejects a directory File with “Directory File updates must use the directory service”, use the existing `file update` staged full replacement: read its exact current bytes, apply the requested edit locally, retain its ID and submit with current version/hash. This is a storage-mode branch, not a permission workaround; other permission errors still require authorized resolution.

Finish with the [receipt and readback criteria](../SKILL.md#5-verify-and-report). Use the shared [recovery process](../SKILL.md#recover-from-the-actual-outcome) for conflicts, uncertain outcomes and requested undo/restoration.
