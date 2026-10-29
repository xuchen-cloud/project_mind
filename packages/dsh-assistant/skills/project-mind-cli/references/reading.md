# Reading and navigation

## Search and read

`mind search '火车 11月 排期'` and `mind search --query '火车 11月 排期'` are equivalent. Supply the runtime binding and exactly one of `--project "$PROJECT_ID"` or `--workspace-scope`. Whitespace separates literal terms combined with AND in the same current Record; its title and body can jointly satisfy the terms across paragraphs or table cells. This is not semantic search: Chinese terms are not guessed or expanded. Choose literal terms from the user's request.

Saved Record search reads current committed content immediately, without waiting for a background index; authorization, exclusion and current-version checks still apply. File search covers indexed content and can be incomplete when indexing or extraction is unavailable. Report returned coverage limits; no full disk scan is performed. An empty bounded result does not prove absence throughout the Workspace.

Default search/list output is readable text. Use the returned Record ID and its actual scope for `record get ID` (or `record get --id ID`), which prints line-numbered text and automatically fetches the pages needed for the Record. Use `--offset 1 --limit 40` for a line window: offset is 1-based and limit counts lines. Automatic pagination preserves object/revision consistency and retains the CLI's explicit capacity limits; report any limit or failure rather than claiming a complete read. Keep table rows and columns together when citing content.

Line numbers refer to the **Source text projection**, which preserves tables but need not match persisted Markdown lines or map 1:1 to blocks. A line window stops fetching once enough complete requested lines are available; the total may remain unknown for a partial read. These flags select read output, not line edits; use canonical block IDs/hashes for patches.

Add `--json` for the existing precise single-page response. Follow its returned cursors manually for required coverage. `record get --json` does not accept line-window `--offset`/`--limit`; use text mode for those. For structured source queries use `source search --input-file PATH`; `search` shorthand does not take `--input-file`. A `record get --input-file PATH` contains the method DTO, not a bare ID; use positional ID or `--id` for that. JSON DTO scope lives inside the input: omit shorthand scope/query/budget flags. Follow [Shell input](shell-input.md) before sending JSON and [Read budgets](record-file.md#read-budgets) for JSON page budgets and `minimumBudgetChars` recovery.

For an overview rather than body search, use **Bash** binding syntax (PowerShell: [Shell input](shell-input.md#powershell)):

```bash
mind context get --project "$PROJECT_ID" --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

## Choose the object and task branch

| User intent | Native object / next step |
| --- | --- |
| A definite action to track until complete | **Todo**; read [Todo guide](todo.md) for listing, creating, completing, scheduling or changing Subtasks. |
| Automatically ask AI to perform work in this conversation at a time or on a repeating schedule | **Scheduled Task**; read [Scheduled Task guide](scheduled-tasks.md), use `mind schedule` and the actual `PROJECT_MIND_SESSION_ID`. A Todo due date does not trigger AI. |
| Information worth retaining, finding and citing independently | **Record**; read [Record/File guide](record-file.md) when reading or writing one. |
| Capture whose final form or destination is undecided | **QuickNote**, the single mutable buffer in its scope. There is no native CLI QuickNote write API. Offer draft text and report it as unsaved; use a Record or Todo only if the user's intent supports that choice. |
| External material managed by a Workspace or Project | **File**; read [Record/File guide](record-file.md) when reading or writing one. |

Project objects belong to one finite, outcome-oriented Project; Workspace objects are independent of a Project. A **Subtask** is a smaller action with its own status, deadline and order, not a progress log. Workspace View is a UI collection of Workspace Todos plus Todos from active Projects; it does not change ownership or grant access to that collection.

## Read enough native evidence

Use `mind search` for literal title/body lookup; `context get` provides bounded Overview/Knowledge navigation, not Record body search. For context questions, follow its relevant source/object references using the exact `source.search` / `source.read` schemas. Use returned revisions, selectors and cursors. Before sending JSON, follow [Shell input](shell-input.md) for Bash stdin or PowerShell's UTF-8 temporary-file recipe. `--input-file -` reads JSON from stdin (up to 2 MiB). Keep transient inputs outside managed Project directories. Cite actual object/version references.

For a new DOCX deliverable, use the native `file_office_create` tool described in the [Record/File guide](record-file.md#office-create-and-inspect), rather than placing a generated file in a watched directory. For inventories, counts, ID batches or title/content matching, use the unified `record.list`, `todo.list`, `file.list` and real-chat `session.list` commands in the [List guide with examples](lists.md). Default to metadata; request detail only when needed. `limit:0` and `totalCount` answer a count in one call; check File `countComplete` for content searches. Voice Records stay in `record.list`.

For today, tomorrow, undated tasks or status/deadline inventories, use `todo.list` in the [Todo guide](todo.md). Follow every page needed for the requested coverage. Use returned parent references and child IDs to select a target, then `todo.get` for its current full state.

For recent-event summaries, read the current authorized scope's native sources, including relevant original sources beyond this Session. Inspect source timestamps and contents for the requested period; a due date is not evidence that an event happened then. Follow pagination as needed and report the scopes, period and source/page limits actually covered. A bounded search, truncated result or unread category cannot establish that nothing else happened.

Stop reading when the task has sufficient evidence or report the remaining coverage limit. A changed-source error requires rereading the current source and restarting its pagination.
