# List, count and batch-read native objects

Discover `mind <record|todo|file|session> list --help` and `mind schema <kind>.list --json`. All four commands accept one JSON input with the same common fields. `record`, `todo` and `file` lists also support common metadata shorthand:

Command examples use **Bash** binding syntax; for PowerShell, follow [Shell input](shell-input.md#powershell).

```bash
mind file list --project "$PROJECT_ID" --limit 20 --query 'Report' --workspace "$WORKSPACE" --connection "$CONNECTION" --json
mind record list --workspace-scope --limit 0 --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

Use `--cursor "$NEXT_CURSOR"` with unchanged scope/query to continue. `--query` maps to `titleQuery`, and `--budget-chars` sets the response budget. Use JSON for detail, content queries, tags and other filters; do not combine `--input-file` with shorthand scope/query/limit/cursor/budget options. Session lists continue to use JSON.

Common JSON fields:

| Field | Meaning |
| --- | --- |
| `scope` | Exactly one authorized Project or Workspace. Workspace never implicitly includes Projects. |
| `mode` | `metadata` (default), or `detail` for metadata plus content. |
| `ids` | Native string IDs from previous results; empty/omitted means all. Maximum 50. |
| `titleQuery` | Literal substring in the title/display text. No `%`, `_`, regex or wildcard expansion. |
| `contentQuery` | Literal substring in content, before counting and pagination. Maximum 256 characters per query. |
| `limit` | 0–50, default 20. **0 returns counts only** with empty items and no continuation. |
| `cursor` | Previous `nextCursor`, with unchanged scope/filters/mode. Restart on `SOURCE_CHANGED`. |
| `budgetChars` | Serialized response budget, 1–12000, default 4000. |

Filters combine with AND; `ids` matches any listed ID. Matching ignores ASCII case; Session and extracted File content also support Unicode case folding. Record, Todo and File additionally accept `tag` (native case-insensitive exact label) and `tagIds` (all listed tag IDs required). Sessions do not have tags. Todo retains `status`, deadline bounds, `undated` and `includeChildren`; children inherit their parent's tags and ID filter, but match their own text/status/deadline. Todo has no separate title, so `titleQuery` and `contentQuery` both match its action text.

Record inventories sort by `updatedAt` descending, with ID descending as a stable tie-breaker. Opening a Record does not change this order.

`totalCount` describes every visible match, not just returned items. `staleCount` is zero for native inventories. File content searches additionally return `countComplete` and `unreadableCount`: if extraction is unavailable/incomplete, report the known matching count and that limitation, never claim an exhaustive result. Excluded/withdrawn objects and unauthorized scopes must not contribute to counts. Archived Project scopes are unavailable; archived DSH chats follow the native visible catalog.

For a count, **one call with `limit:0` is enough**; do not enumerate pages or read bodies. Todo counts are action counts when `includeChildren:true` (the compatibility default); use `includeChildren:false` when the user means parent Todos only.

In metadata mode, Record/File/Session bodies are absent. Todo retains its existing bounded display `content` (240 characters), `contentTruncated` and optional parent display text. Detail mode returns complete Record Markdown, Todo action text, extracted File text, or DSH human conversation text. Session text includes user/assistant/tool messages, excluding system/developer prompts, replacement-only model history and non-text attachments. File extraction reports `contentComplete`, `contentState` and `contentReason`; unavailable reads also preserve the full `contentError` (code, message, retryable and details). Office `contentError.details.reason:"unsupported_format"` is non-retryable text extraction and carries an Office inspect hint. Other `SOURCE_NOT_READY` reasons keep their actual recovery meaning; an unsupported binary is not an empty document. A detail item that cannot fit fails explicitly with `BUDGET_EXCEEDED`; use metadata mode, or paginated `record.get`/`source.read` for large Record/File bodies instead of interpreting an excerpt as the full document. Chat detail currently requires the whole selected conversation text to fit in 12000 characters including metadata; oversized chats return an explicit budget error, and their metadata remains available.

Voice Records are Records: `record.list` includes both `recordType:"text"` and `recordType:"voice"` once each. Record detail is the committed Record body; its Transcript is a separate source of that same Voice Record. `session.list` means real DSH **chat** sessions, not recording sessions or the retired Pi metadata table.

## Bash examples

`$PROJECT_ID`, `$WORKSPACE`, `$CONNECTION`, IDs and tag IDs must come from the current binding or native results. These examples use **Bash** JSON stdin. For PowerShell binding, JSON serialization and temporary-file input, follow [Shell input](shell-input.md#powershell) with the same DTO.

Count Records in one call:

```bash
mind record list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"project","projectId":$PROJECT_ID},"limit":0}
JSON
```

Batch-read two complete Record bodies (within the response budget):

```bash
mind record list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"project","projectId":$PROJECT_ID},"ids":["$RECORD_ID_A","$RECORD_ID_B"],"mode":"detail","budgetChars":12000}
JSON
```

Find Record metadata by title, body and tag together:

```bash
mind record list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"project","projectId":$PROJECT_ID},"titleQuery":"复盘","contentQuery":"部署","tag":"研发","mode":"metadata","limit":10}
JSON
```

Count unfinished parent Todos with a tag; then read matching parent/child action text:

```bash
mind todo list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"project","projectId":$PROJECT_ID},"status":"unfinished","tagIds":[$TAG_ID],"includeChildren":false,"limit":0}
JSON
mind todo list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"project","projectId":$PROJECT_ID},"ids":["$TODO_ID"],"tag":"研发","contentQuery":"验收","includeChildren":true,"mode":"detail","budgetChars":12000}
JSON
```

Find Files by title, or by extracted content with details:

```bash
mind file list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"project","projectId":$PROJECT_ID},"titleQuery":"方案","mode":"metadata"}
JSON
mind file list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"project","projectId":$PROJECT_ID},"contentQuery":"兼容性","tagIds":[$TAG_ID],"mode":"detail","limit":5,"budgetChars":12000}
JSON
```

Find real Workspace chats, or batch-read a chosen chat's conversation text:

```bash
mind session list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"workspace"},"titleQuery":"发布","contentQuery":"回滚","mode":"metadata"}
JSON
mind session list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"workspace"},"ids":["$SESSION_ID"],"mode":"detail","budgetChars":12000}
JSON
```

Continue an inventory with **all the original filters** and the returned cursor:

```bash
mind record list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":{"kind":"project","projectId":$PROJECT_ID},"tag":"研发","limit":10,"cursor":"$NEXT_CURSOR"}
JSON
```

## Consistent object references and small-budget reads

Record read inputs (`record.get`, `record.blocks.get`, `record.versions.list/get/compare`) use `object`, matching File reads. Legacy `record` remains accepted as an input alias; never send both. Use the exact returned ObjectRef, not a reconstructed reference:

```bash
mind record versions list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"object":$RECORD_OBJECT,"limit":10}
JSON
mind file versions list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"object":$FILE_OBJECT,"limit":10}
JSON
```

For `record.get` / `source.read` budget accounting and recovery using `minimumBudgetChars`, follow [Read budgets](record-file.md#read-budgets). In a `source.read` budget error, the returned authorized `object` and bounded `title` already establish that source's existence/title; reuse that evidence rather than probing again just for it. List-detail budget errors still follow the list behavior above.
