# Writes, recovery and verification

Before any Todo, Record or File mutation, read [Binding and authorization](binding.md), then follow this guide and the object-specific guide linked below. Command examples use **Bash**; PowerShell must use [Shell input](shell-input.md#powershell).

## Apply the requested change

Before creating, modifying or appending to a Todo, Record or File:

1. Establish the authorized scope and the object or independent outcome the user means. Reuse native evidence already read for this task.
2. If evidence is insufficient, use bounded relevant native lists/source queries and necessary pagination within that authorization. Stop once the target/creation decision is supported. A finite query or unread page cannot prove no matching object exists; if ambiguity affects identity or could overwrite the wrong content, ask the user before writing.
3. Choose create, modify or append using the [Todo rules](todo.md#choose-create-or-update) or [Record/File rules](record-file.md#choose-create-or-continue). A similar title/text alone does not settle identity.

For an existing target, read the content needed for the edit and keep its current CAS baseline: Todo `expectedRevision`, Record `baseRevision`, File `expectedVersionNumber` and `expectedContentHash`. Reuse a sufficient current native read; reread after intervening changes or a conflict. Build the mutation from the method schema and the relevant branch guide.

Allocate one stable request ID per intended mutation (1–128 UTF-8 bytes) and retain it with the exact payload, excluding credentials. Most writes use `{"requestId":"…","input":{…}}`; `record.patch` takes native RecordPatch JSON. If also supplied as `--request-id`, the ID must match the payload. Preview/staging is not a save.

The current Todo/Record/File methods settle each object's mutation independently, keeping recovery and undo tied to its native receipt/version. Batch creation is deferred until actual multi-object volume or call costs justify defining batch authorization, atomicity and undo; stable request IDs can support such a design. Use the installed per-object methods for current work.

### Recover from the actual outcome

Read JSON stdout even on a failed process: responses contain `ok` and either `data` or `error`. Inspect `error.code`, `message`, `retryable` and `details`.

- **Uncertain write:** inspect receipts through the same connection's `operation.list` / `operation.get`, and replay only the original request ID with its exact payload to resolve the outcome. Never blindly allocate new IDs and repeat a possibly successful write.
- **Revision conflict:** reread the target, reconcile the requested change with current content, then build a new mutation with the current baseline and a new stable ID. Preserve unrelated fields; never guess or increment a revision.
- **Input failure:** correct the DTO against the schema after establishing the failed attempt did not commit; a changed payload is a new mutation.
- **Permission/binding failure:** stop for the required user/runtime action; grants and read-only mode still apply.
- **Requested undo/restoration:** discover `operation.undo` or `operation.restore_created` (CLI `operation restore-created`), use its current revision guard and a new stable ID. Creation withdrawal preserves identity; restoration is not another create.

For a known receipt ID, this **Bash** example uses stdin; PowerShell uses the complete [Shell input recipe](shell-input.md#powershell):

```bash
mind operation get --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"operationId":"$OPERATION_ID"}
JSON
```

## Verify and report

A write is complete when the native success result and **Operation Receipt** identify the actual object/version, and a fresh authorized read confirms the requested fields or content. For several requested writes, use the current per-object methods with a request ID, exact payload, receipt/replay and readback for each mutation. Report saved objects/versions and any failed, uncertain or unattempted items separately; partial success is not an atomic batch. Retain operation IDs and before/after revisions. A preview, upload stage, local file or model statement is not persistence evidence.

For binary Files, verify both the exact bytes (fixed version/hash/length) and the requested document meaning through Office inspect. A matching hash alone does not prove the requested content. A subsequent v2 edit must use the newly returned version/hash as its baseline; do not carry forward v1 CAS values.

Frontend automatic refresh is a separate product acceptance check. If UI acceptance is requested, verify that the already-open view updates without manual refresh. Receipt plus readback proves persistence; claim automatic refresh only when observed. Report any unverified UI behavior separately from the saved result.

For Word/Excel/PowerPoint generation or layout/structure editing, use the bundled [GenOffice authoring Skill](../../genoffice-authoring/SKILL.md) and the actual native Office tools.
