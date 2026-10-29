# Reading and navigation

Examples use the [runtime binding defaults](binding.md#runtime-defaults); explicit external binding is described separately there. IDs come from authorized results and retain their original scope.

## Search and read

```sh
mind search '火车 11月 排期' --kind record,file --all
mind record get 44
mind todo get 12
mind file get 9 --format plain
```

`search QUERY` and `search --query QUERY` are equivalent. Whitespace-separated literal terms use AND across the same source's title and body, including different paragraphs or indexed chunks. Chinese terms are not guessed or expanded. Saved Records are searched from committed content immediately. Other sources depend on their search index and extraction coverage; an empty result cannot prove that unindexed material contains no match. For direct native line matching, use [grep](grep.md).

Search accepts `--limit 1..50`, `--kind` with a comma-separated kind list, and a returned `--cursor`. `--all` follows pages in readable output; JSON plus `--all` is rejected. Keep the same scope, query and filters while continuing. `source search` accepts the same shorthand or a `--input-file` DTO; `search` itself does not accept a DTO file. Report coverage/stale warnings and restart after a changed-source error.

## Formats, windows and completion

- **Default reading:** common reads/lists default to readable output. `record get ID` displays canonical Markdown with a header and line numbers, preserving tables without a format flag. Record/File reads fetch successive pages automatically; complete lines appear as they arrive. A later failure gives a nonzero exit code and partial-output diagnostics. Earlier stdout is not proof of a complete read.
- **Text:** explicit Record `--format text` displays the source text projection with line numbers. Its lines can differ from the default Markdown lines.
- **Plain:** `--format plain` or `--format cat` removes reading headers/line numbers; Record uses its text projection, File uses extracted text. Metadata and warnings remain on stderr. `cat` is a format alias, not a separate command.
- **Markdown:** `record get ID --format markdown` writes the exact saved Markdown projection to stdout, retaining table structure. Source revision and numeric `headRevision` are on stderr. Use the whole Markdown output as the baseline for [Record edit](record-file.md#record-text-edits).
- **JSON:** `--json` / `--format json` returns one original protocol page, including selectors, spans and `nextCursor`. Record JSON retains the text projection default; a DTO can select its supported projection explicitly. Follow pages manually when the task requires them; a single page may contain only part of a line.

Record `--offset LINE --limit LINES` selects a 1-based **server-side** window in every format, including JSON and Markdown. The response's `window` gives `totalLines` and the current page's covered `startLine/endLine`; those line numbers belong to the selected text/Markdown projection. `rangeComplete:true` with no cursor completes the requested window even when `complete:false` because the entire document was not requested. A window is not a full Markdown edit baseline.

`record get` returns numeric `headRevision` from the same saved snapshot as the content. It is the `--base-revision` for writes. `sourceRef.revision` is a source hash, not that numeric CAS revision. Neither Markdown lines nor displayed text lines map 1:1 to blocks.

File `get` reads the current managed File's extracted text, not original binary bytes. `source read --kind file --id ID` offers the same native source path; DTO input supports exact revisions, versions and ranges. `file source read` is a separate byte-oriented JSON API. For Office inspection or fixed-byte download, read [Record/File](record-file.md#office-create-and-inspect). Incomplete extraction remains visible even after all available text pages were read.

Use [Shell input](shell-input.md) for DTOs. A JSON input contains its own scope and filters; keep shorthand scope/query/window flags out of that call. Page metadata has a dynamic minimum budget: see [Read budgets](record-file.md#read-budgets). Capacity limits and interruptions must remain visible; a downstream pipe intentionally stopping early does not establish full source coverage.

## Choose the object and task branch

| User intent | Native object / next step |
| --- | --- |
| Track a definite action until complete | [Todo](todo.md), including its independent Subtasks. |
| Start AI work at a scheduled time | [Scheduled Task](scheduled-tasks.md), attached to the actual Workspace Session. |
| Retain independently findable information | Record; use [Record/File](record-file.md). |
| Capture whose destination is undecided | QuickNote, the single mutable buffer in its scope. No CLI QuickNote write API is available; report drafts as unsaved. |
| Read or revise managed external material | File; use [Record/File](record-file.md). |

## Context and evidence

`mind context get --json` provides bounded Overview/Knowledge navigation; use grep/search for source bodies. Follow relevant returned object/source references with the exact `source.read` schema. `reference list --kind record --id ID --direction incoming|outgoing` follows native references. Object-limited grants require permitted object reads rather than scope-wide navigation.

For inventories, batch IDs, tags or counts, use [Lists](lists.md); Voice Records are Records, while `session list` lists real assistant chats. For local-date Todo questions, use [Todo date filters](todo.md#list-the-exact-scope).

For recent-event summaries, read relevant original sources within the authorized scope and period, not just the current chat. Inspect source timestamps and content; a deadline is not evidence that an event happened then. Report scopes, periods, unread pages and unavailable categories actually covered. Reread and restart pagination after a changed-source error.
