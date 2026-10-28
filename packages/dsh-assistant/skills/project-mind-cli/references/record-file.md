# Record / File guide

Load this branch only for Record or File work. Discover the relevant subcommand help and exact method schema before constructing input; the installed CLI owns field names and limits.

Command examples use **Bash** binding syntax. For PowerShell paths and JSON input, follow [Shell input](shell-input.md#powershell).

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

### Read budgets

For `record.get` and `source.read`, `budgetChars` counts Unicode characters in the **serialized page**, including metadata, spans, excerpt and cursor, rather than just body text. The default is 4000; the schema allows positive budgets up to 12000. Even a short Record can exceed a small budget because its page metadata must fit.

When `BUDGET_EXCEEDED` returns `error.details.minimumBudgetChars`, that value is the dynamic budget needed for the page metadata plus at least one body character (or an empty page for an empty body). It is not a fixed constant or proportional to the full document length. Increase `budgetChars` to at least the returned minimum within the method's schema limit, preserving the source/object, selection, revision and cursor so the same read can progress. If the minimum exceeds the schema maximum, report that actual limit instead of retrying an invalid budget. Apply this recovery only to these page reads when the error supplies the field; other `BUDGET_EXCEEDED` errors retain their method-specific meaning.

## Record create / patch

For a new Record, prepare UTF-8 Markdown, preview, then commit the intended payload with a stable request ID. `$PROJECT_ID` comes from the binding/authorized reads; for Workspace Records replace `--project "$PROJECT_ID"` with `--workspace-scope`:

```bash
mind record create --title 'Release notes' --body-file note.md --project "$PROJECT_ID" --dry-run --workspace "$WORKSPACE" --connection "$CONNECTION" --json
mind record create --title 'Release notes' --body-file note.md --project "$PROJECT_ID" --request-id "$CREATE_REQUEST_ID" --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

Existing Record edits use `record.patch`'s native RecordPatch shape, including current `baseRevision`, canonical block identities/hashes and its stable `requestId`. `--patch-file` accepts that JSON directly:

```bash
mind record patch --patch-file patch.json --dry-run --workspace "$WORKSPACE" --connection "$CONNECTION" --json
mind record patch --patch-file patch.json --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

For small transient JSON inputs, follow [Shell input](shell-input.md): Bash can use stdin (`--input-file -` / `--patch-file -`); PowerShell should use a system temporary file with the corresponding `--input-file` / `--patch-file` option. Keep these inputs outside managed directories. Record create/patch dry-run saves no version or receipt and may omit the mutation request ID. Preview does not reserve the baseline: commit checks it again. Discover schema limits before preparing a large body.

## File create / replace

Files belong to a Workspace or one Project. They share the same import, version, editing and receipt pipeline. Workspace Files are managed under the Workspace `files` directory; they do not change the ownership of Project Files. `file create --name NAME --body-file PATH --project ID` creates UTF-8 content in a Project; use `--workspace-scope` for Workspace Files. Workspace authorization does not automatically include every Project. For full content replacement, preserve identity and use the current File version/hash:

```bash
mind file update --id "$FILE_ID" --source-file replacement.bin --project "$PROJECT_ID" --expected-version "$FILE_VERSION" --expected-hash "$FILE_HASH" --request-id "$UPDATE_REQUEST_ID" --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

For Workspace File replacement, use `--workspace-scope` instead of `--project "$PROJECT_ID"`; preserve the actual Workspace File object, ID, version and hash. Project-only callers cannot create or edit Workspace Files.

To create already-generated binary bytes as an independent File, use a new stable request ID:

```bash
mind file create --name 'Report.docx' --source-file report.docx --project "$PROJECT_ID" --request-id "$CREATE_REQUEST_ID" --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

Use `--workspace-scope` for Workspace ownership. This uploads bytes and commits through native `file.create`, producing its actual File identity, version, hash and Operation Receipt. It does not convert text to Office format. Explicit `file upload` also accepts a JSON target containing only `createTarget:{workspaceId,projectId,safeName}`; `projectId:null` means Workspace ownership. Existing-object upload retains its ordinary object/version/hash target.

Paths stay local; the CLI stages bytes before committing. Explicit staged uploads use `file.content.*` and the `file.create` or `file.update` schema for their target; a completed upload stage is not a committed File version.

If `file.patch` rejects a directory File with “Directory File updates must use the directory service”, use the existing `file update` staged full replacement: read its exact current bytes, apply the requested edit locally, retain its ID and submit with current version/hash. This is a storage-mode branch, not a permission workaround; other permission errors still require authorized resolution.

Finish with the [receipt and readback criteria](../SKILL.md#5-verify-and-report). Use the shared [recovery process](../SKILL.md#recover-from-the-actual-outcome) for conflicts, uncertain outcomes and requested undo/restoration.


## Office create and inspect

For Word, Excel or PowerPoint generation and full format editing, load the bundled [GenOffice authoring Skill](../../genoffice-authoring/SKILL.md), then its relevant format reference. `file_office_create` creates the actual `.docx`/`.xlsx`/`.pptx` and commits through the same native File pipeline. Word accepts the existing restricted HTML string or upstream HTML+ops; Excel uses the full workbook gateway; PPT uses native page specs and operations. The bundled engines require no standalone GenOffice app or separate model/account configuration.

A stable `request_id` identifies the original complete create payload. In a Project Session the default is the actual Project; a Workspace Session defaults to Workspace ownership, or accepts an explicitly authorized `project_id`. Keep the same File and current SourceRef when continuing edits. Full format operations retain native authorization, version CAS and read-only restrictions.

`file_office_inspect` accepts exactly one of `file_path` or `source_ref`. For a native saved File, pass its complete returned SourceRef directly as `source_ref`, retaining its actual object, revision and File version. Do not reconstruct a local path or reduce the SourceRef to an ID. Inspection checks the document's semantic content; inspect headings, paragraphs and table values that establish the requested deliverable.

To read back exact saved bytes for local inspection or editing, first obtain the authorized ObjectRef and fixed version/hash from the native result or version read. Build the exact `file.bytes.read` DTO from `mind schema file.bytes.read --json`, then:

```bash
mind file download --input-file read.json --out downloaded.docx --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

The output path must be new. The CLI verifies returned byte length and SHA-256 before writing; stdout contains metadata without base64. Compare its fixed version/hash/length to the save result, then perform Office semantic inspection. After replacing the same File to create v2, reread and use v2's actual version/hash for every later edit; successful v1 verification does not establish v2 content.

## Managed directories and extraction status

Workspace Files live under Workspace `files/`; Project Files live under their actual Project directory. Use the supplied context and native references to distinguish them. The background scanner discovers new directory files in batches about every five seconds. A locally written file becoming visible through discovery does not produce a CLI creation Operation Receipt and is not evidence that a native create call succeeded. Use native create for requested saved deliverables. Never manually create or maintain internal `.pm-versions` content.

DOCX/XLSX/PPTX currently have unavailable text extraction, rather than empty text. In detail lists, inspect `contentError.details.reason:"unsupported_format"`, `contentError.retryable:false` and the Office inspect recovery hint. Use Office inspect for supported document inspection. Other `SOURCE_NOT_READY` errors retain their own message, reason and retryability; follow that actual error rather than treating all not-ready states as unsupported or permanently non-retryable. Content search counts remain incomplete when relevant Files cannot be extracted.
