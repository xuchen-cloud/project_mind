# Record / File guide

Load this branch for structured Record/File reads, writes or budget recovery. For ordinary search and text reads, use the [quick card](../SKILL.md#find-and-read). Discover the relevant subcommand help and exact method schema before constructing JSON input; the installed CLI owns field names and limits.

Command examples use the existing [runtime defaults](binding.md#runtime-defaults). Code marked `bash` is Bash, including redirection; PowerShell paths, files and capture use [Shell input](shell-input.md#powershell). Use [external binding](binding.md#external-binding) only when runtime defaults are absent.

## Choose create or continue

Apply the shared [binding/authorization check](binding.md#check-binding-and-authorization) and [write decision](writes.md#apply-the-requested-change). Reuse already-read native references/content; when insufficient, follow relevant authorized source queries, references and necessary pages to establish the target. A bounded result cannot establish that the entire scope contains no related object.

- **Record:** append new facts or correct affected passages in the same Record when that is the user's intended information unit. Apply the requested edit to the current body and preserve unrelated content; native versions retain prior committed text. Create a new Record for independently useful information or an explicitly separate entry. A shared topic/title alone does not justify combining independent entries.
- **File:** continue edits, additions or replacements of the same managed material through its existing File ID, producing a new version. Create a File for an independent deliverable. A filename is neither object identity nor a ban on creating another File with that name; resolve the user's intended material and Workspace or Project scope using native evidence.

## List, count or batch-read

Use the [unified List guide](lists.md) for `record.list` and `file.list`, metadata/detail modes, ID batches, title/content substring queries, tags, counts and pagination examples. Voice Records are included in `record.list`, distinguished by `recordType`.

Record read DTOs now use `object`, matching File reads; `record` remains an input alias for compatibility. Record metadata includes title, tags, createdAt, updatedAt and nullable lastEditedAt (the committed body head time). Do not confuse modification time with the event date described in the body.

## Read the current content

- **Record:** `record get ID` defaults to canonical Markdown with a header, line numbers and automatic pagination, preserving tables. Explicit `--format text` selects line-numbered source text. `--format markdown` gives exact saved Markdown without reading headers or line numbers; `--format plain` (alias `cat`) gives raw source text. Numeric `headRevision` and the source hash are distinct: use the head revision for edits. `--offset 1 --limit 40` selects a server-side line window in any format, including JSON; the window's lines belong to the selected projection. [Reading](reading.md#formats-windows-and-completion) explains page/window completion.
- **File:** `file get ID` reads current extracted text; plain mode is suitable for pipes. `source read` supports native source DTOs/ranges. `file source read` is the separate byte-oriented JSON API. Obtain the fixed version number and full `sha256:…` hash before changing original File bytes.

Read all evidence needed for the intended change. Streaming can fail after partial stdout: check the process result and diagnostics before using output as a complete baseline. Pending editor previews are not Committed Content; resolve actual editor-busy/pending-review errors before commit. Historical evidence uses `record versions` / File version methods; block-level tools are available for callers that need structured identity.

### Read budgets

For precise JSON page reads through `record.get` and `source.read`, `budgetChars` counts Unicode characters in the **serialized page**, including metadata, spans, excerpt and cursor, rather than just body text. The service JSON default is 4000; the schema allows positive budgets up to 12000. Human automatic reads request 12000 when no budget was supplied. Even a short Record can exceed a small budget because its page metadata must fit. Ordinary `record get` text reads handle pagination automatically; use JSON when you need the exact page metadata or a cursor/selector.

When `BUDGET_EXCEEDED` returns `error.details.minimumBudgetChars`, that value is the dynamic budget needed for the page metadata plus at least one body character (or an empty page for an empty body). It is not a fixed constant or proportional to the full document length. Increase `budgetChars` to at least the returned minimum within the method's schema limit, preserving the source/object, selection, revision and cursor so the same read can progress. If the minimum exceeds the schema maximum, report that actual limit instead of retrying an invalid budget. Apply this recovery only to these page reads when the error supplies the field; other `BUDGET_EXCEEDED` errors retain their method-specific meaning.

## Record text edits

Ordinary text edits need no manual block IDs. Use the current numeric `headRevision` as `--base-revision`, from the same successful full read used to prepare the change. The source hash is not this number. IDs, revision and request-ID variables below come from actual task results; examples use Bash.

Choose the narrowest operation:

| Command | Input and behavior |
| --- | --- |
| `record replace ID --old-text-file old.txt --new-text-file new.txt` | Literal replacement of one unique contiguous text occurrence. It can span text marks, but not blocks, hard breaks or inline references. A missing/ambiguous match fails; use a longer unique old text or a Markdown baseline edit. |
| `record append ID --body-file additions.md` | Parse UTF-8 Markdown and append it to the same Record. |
| `record edit ID --before-file before.md --body-file after.md` | Apply the difference from the exact saved Markdown baseline, retaining existing structure/identity where it can be mapped. Ambiguous or unsupported changes fail explicitly; narrow the diff or use a unique literal replacement. |

For a Markdown edit, capture the whole current baseline, retain its reported head revision, then make an edited copy. **Bash** capture:

```bash
mind record get 44 --format markdown > before.md || exit "$?"
```

PowerShell uses [exact Markdown capture](powershell-baseline.md); Windows PowerShell 5.1 text redirection can write UTF-16 or alter trailing newlines. A window, line-numbered output, error output or partial stream is not a full baseline. The converter normalizes CRLF to LF for the Markdown comparison, without accepting changed baseline content.

Once `after.md` contains the intended edit and `$HEAD_REVISION` is the actual numeric head from that read:

```bash
mind record edit 44 --before-file before.md --body-file after.md --base-revision "$HEAD_REVISION" --dry-run
mind record edit 44 --before-file before.md --body-file after.md --base-revision "$HEAD_REVISION" --request-id "$EDIT_REQUEST_ID"
```

Run commit after inspecting a successful preview. Preview needs no request ID, writes no version/receipt and does not reserve the revision. Commit requires one stable request ID; if any file, baseline or requested change changes, reassess the preview and operation identity. All three text shortcuts return JSON without requiring an extra `--json`; inspect `ok/error`, the actual result/receipt, then read back. `--budget-chars` applies to their dry-run preview only. Each file can be a path or `-`, but at most one input may consume stdin; [UTF-8 files](shell-input.md#powershell) are the portable choice for complex text.

These operations preserve native permissions, CAS, editor coordination, references and saved rich content. They do not turn displayed line numbers into block IDs. Follow [recovery](writes.md#recover-from-the-actual-outcome) for conflicts or uncertain commits.

## Record create and block patches

For a distinct new Record, prepare UTF-8 Markdown and use:

```bash
mind record create --title 'Release notes' --body-file note.md --dry-run --json
mind record create --title 'Release notes' --body-file note.md --request-id "$CREATE_REQUEST_ID" --json
```

The runtime's authorized default scope determines ownership; select an explicit authorized scope when needed. Native block-level `record patch --patch-file patch.json` remains available for structured patches. Read `record.blocks.get` to obtain canonical block IDs/hashes, and construct the native RecordPatch against its current base revision. Add `--dry-run` for a preview, then commit the same intended patch with its stable request ID. Use `mind schema record.patch --json` for the actual contract. Keep these details on the block-patch path rather than requiring them for ordinary reads or text edits.

## File create / replace

Files belong to a Workspace or one Project. They share the same import, version, editing and receipt pipeline. Workspace Files are managed under the Workspace `files` directory; they do not change the ownership of Project Files. `file create --name NAME --body-file PATH --project ID` creates UTF-8 content in a Project; use `--workspace-scope` for Workspace Files. Workspace authorization does not automatically include every Project. For full content replacement, preserve identity and use the current File version/hash:

```bash
mind file update --id "$FILE_ID" --source-file replacement.bin --project "$PROJECT_ID" --expected-version "$FILE_VERSION" --expected-hash "$FILE_HASH" --request-id "$UPDATE_REQUEST_ID" --json
```

For Workspace File replacement, use `--workspace-scope` instead of `--project "$PROJECT_ID"`; preserve the actual Workspace File object, ID, version and hash. Project-only callers cannot create or edit Workspace Files.

To create already-generated binary bytes as an independent File, use a new stable request ID:

```bash
mind file create --name 'Report.docx' --source-file report.docx --project "$PROJECT_ID" --request-id "$CREATE_REQUEST_ID" --json
```

Use `--workspace-scope` for Workspace ownership. This uploads bytes and commits through native `file.create`, producing its actual File identity, version, hash and Operation Receipt. It does not convert text to Office format. Explicit `file upload` also accepts a JSON target containing only `createTarget:{workspaceId,projectId,safeName}`; `projectId:null` means Workspace ownership. Existing-object upload retains its ordinary object/version/hash target.

Paths stay local; the CLI stages bytes before committing. Explicit staged uploads use `file.content.*` and the `file.create` or `file.update` schema for their target; a completed upload stage is not a committed File version.

If `file.patch` rejects a directory File with “Directory File updates must use the directory service”, use the existing `file update` staged full replacement: read its exact current bytes, apply the requested edit locally, retain its ID and submit with current version/hash. This is a storage-mode branch, not a permission workaround; other permission errors still require authorized resolution.

Finish with the [receipt and readback criteria](writes.md#verify-and-report). Use the shared [recovery process](writes.md#recover-from-the-actual-outcome) for conflicts, uncertain outcomes and requested undo/restoration.


## Office create and inspect

For Word, Excel or PowerPoint generation and full format editing, load the bundled [GenOffice authoring Skill](../../genoffice-authoring/SKILL.md), then its relevant format reference. `file_office_create` creates the actual `.docx`/`.xlsx`/`.pptx` and commits through the same native File pipeline. Word accepts the existing restricted HTML string or upstream HTML+ops; Excel uses the full workbook gateway; PPT uses native page specs and operations. The bundled engines require no standalone GenOffice app or separate model/account configuration.

A stable `request_id` identifies the original complete create payload. In a Project Session the default is the actual Project; a Workspace Session defaults to Workspace ownership, or accepts an explicitly authorized `project_id`. Keep the same File and current SourceRef when continuing edits. Full format operations retain native authorization, version CAS and read-only restrictions.

`file_office_inspect` accepts exactly one of `file_path` or `source_ref`. For a native saved File, pass its complete returned SourceRef directly as `source_ref`, retaining its actual object, revision and File version. Do not reconstruct a local path or reduce the SourceRef to an ID. Inspection checks the document's semantic content; inspect headings, paragraphs and table values that establish the requested deliverable.

To read back exact saved bytes for local inspection or editing, first obtain the authorized ObjectRef and fixed version/hash from the native result or version read. Build the exact `file.bytes.read` DTO from `mind schema file.bytes.read --json`, then:

```bash
mind file download --input-file read.json --out downloaded.docx --json
```

The output path must be new. The CLI verifies returned byte length and SHA-256 before writing; stdout contains metadata without base64. Compare its fixed version/hash/length to the save result, then perform Office semantic inspection. After replacing the same File to create v2, reread and use v2's actual version/hash for every later edit; successful v1 verification does not establish v2 content.

## Managed directories and extraction status

Workspace Files live under Workspace `files/`; Project Files live under their actual Project directory. Use the supplied context and native references to distinguish them. Native directory discovery can make locally written files visible, but that does not produce a CLI creation Operation Receipt or prove a native create call succeeded. Use native create for requested saved deliverables. Never manually create or maintain internal `.pm-versions` content.

DOCX/XLSX/PPTX currently have unavailable text extraction, rather than empty text. In detail lists, inspect `contentError.details.reason:"unsupported_format"`, `contentError.retryable:false` and the Office inspect recovery hint. Use Office inspect for supported document inspection. Other `SOURCE_NOT_READY` errors retain their own message, reason and retryability; follow that actual error rather than treating all not-ready states as unsupported or permanently non-retryable. Content search counts remain incomplete when relevant Files cannot be extracted.
