# Todo guide

## Choose create or update

Apply the shared [binding/authorization check](../SKILL.md#check-binding-and-authorization) and [write decision](../SKILL.md#4-apply-the-requested-change) before creating or changing a Todo. Reuse relevant native evidence; if needed, list the intended scope with appropriate date/status filters and read plausible targets with `todo.get`.

- **Create:** the user means a distinct action or deliverable. Similar text alone does not justify merging; different dates, occurrences or delivery meaning can warrant separate Todos. A bounded list does not prove that no related Todo exists.
- **Update:** the user refers to the same action. Use its native ObjectRef and current revision; change only the requested content, status, priority, deadline or children, preserving other fields.
- **Append:** add a Subtask only for an action clearly subordinate to that parent Todo. Confirm the parent from native evidence; topical similarity or a progress note is insufficient. Save informational facts as a Record when that matches the user's intent.

## List the exact scope

Discover `mind todo list --help` and `mind schema todo.list --json`. For today/tomorrow, resolve the user's local calendar date, then pass that same explicit `YYYY-MM-DD` as both bounds. For undated work, use `undated:true` with no date bounds.

| Input | Meaning |
| --- | --- |
| `scope` | Required exact authorized Workspace or Project object scope. |
| `status` | Optional `unfinished` or `finished`; omission includes both. |
| `dueFrom`, `dueTo` | Optional inclusive due-date bounds. |
| `undated` | Optional boolean, default `false`; `true` is mutually exclusive with date bounds. |
| `includeChildren` | Optional boolean, default `true`. |
| `cursor` | Returned continuation cursor. |
| `limit`, `budgetChars` | Optional page bounds: 1–50 items (default 20), 1–12000 serialized page characters (default 4000). |

Set `$TODO_SCOPE` to the task's authorized scope JSON: `{"kind":"workspace"}`, or Project scope with the exact supplied/returned Project ID. `$DAY` is the resolved local date. These are input variables, not credentials:

```sh
mind todo list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":$TODO_SCOPE,"status":"unfinished","dueFrom":"$DAY","dueTo":"$DAY","limit":50,"budgetChars":12000}
JSON

mind todo list --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"scope":$TODO_SCOPE,"status":"unfinished","undated":true,"limit":50,"budgetChars":12000}
JSON
```

Results are flat `items`: parents and Subtasks match their **own** due date and status, with no inheritance. A child may match when its parent does not, and completing a parent does not complete its children. Each item contains `object` (the parent Todo's ObjectRef), optional `childId`, parent `revision`, content, own status/dueDate, parent priority and optional `parentContent`. Use the exact returned `object` for `todo.get`/update target and returned `childId` only for the selected child mutation. `content` is capped at 240 characters with `contentTruncated`; `parentContent` is also a display label capped at 240 characters. Use `todo.get` for full fields before editing.

Continue with `nextCursor` while `hasMore`, preserving the scope and filters; do not silently drop pages. Either finish pagination or report bounded coverage, including any unqueried Projects. Workspace scope lists Workspace-owned objects only; a full Workspace View requires separate authorized active-Project scopes as well. Use native list/source references to find IDs; arbitrary character searches and guessed IDs cannot replace enumeration.

The cursor binds query filters, the binding/grant and the native change sequence. A concurrent mutation can return `SOURCE_CHANGED`: discard that cursor and restart the same query without `cursor`. Use the restarted pages for coverage claims; do not combine pages from different change sequences into a supposedly complete inventory.

Todo content-text filtering is deferred while the existing filters and bounded pages cover current inventories. Assess it when measured object counts or call costs justify it; content filtering can be incorporated into the existing cursor's query fingerprint. Use the supported filters and report actual coverage.

## Values and date semantics

| Priority | Meaning |
| --- | --- |
| `urgent_important` | Urgent and important |
| `urgent_not_important` | Urgent, not important |
| `not_urgent_important` | Important, not urgent |
| `not_urgent_not_important` | Neither urgent nor important |

JSON `todo.create` requires an explicit `priority`, `dueDate`, `tagIds` and `children`; there is no JSON priority default. The `todo create --body-file` shorthand defaults to `not_urgent_not_important`, no due date, no tags and no children. Choose priority deliberately; use empty arrays when no tags/children are requested. Native new Todos and new Subtasks start `unfinished`; status values are exactly `unfinished` and `finished`.

Dates are valid calendar dates in exact `YYYY-MM-DD` form. `dueDate:null` means no deadline. Missing `dueDate` is invalid in create, each new child, `deadline`, `child_create` and `child_update`; it never means preserve. To leave a parent's deadline unchanged, omit the entire `deadline` change. To preserve a child's deadline, copy its current `dueDate`, including null, into `child_update`; this mutation also requires current content, `progressDate` and explicit status.

`progressDate` is the child's stored recording date, distinct from deadline, creation timestamp and completion timestamp. The UI parser supplies local today on add and preserves the existing value on edit; `@MMDD` / `@YYYYMMDD` sets **dueDate**, not progressDate. Native writes validate and store the supplied progressDate; the CLI does not infer it from content. Supply local today for a new child and preserve the read value on edit unless changing that date is intended. Native completion manages `completedAt` separately.

## Minimal stdin writes and readback

Inspect `todo.create`, `todo.get`, `todo.update` schemas first. The shell snippets below use `jq` only to carry native JSON forward; if unavailable, construct the same DTO from returned JSON. Variables last only within their shell execution: rebind from prior native results when using another tool shell. Replace the sample request IDs **once before first execution** with IDs unique to this task; keep the chosen ID and exact payload for recovery, including generated child updates. Execute only recipes that match the requested change. Todo supports native create/update, **not dry-run**; tell the user when a requested trial/preview cannot be executed and describe the proposed change without writing.

### Create

`$TODO_SCOPE` is the authorized scope JSON established above. This creates one undated Todo with explicitly chosen importance and no urgency:

```sh
created=$(mind todo create --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"requestId":"delivery-create-001","input":{"scope":$TODO_SCOPE,"content":"Deliver the draft","priority":"not_urgent_important","dueDate":null,"tagIds":[],"children":[]}}
JSON
)
printf '%s\n' "$created"
TODO_TARGET=$(printf '%s\n' "$created" | jq -ce 'select(.ok == true) | .data.result.object')
```

Inspect the receipt before continuing. For an existing Todo, obtain `$TODO_TARGET` from a native result's ObjectRef (e.g. `todo.list` item `object`), not a reconstructed ID. An ObjectRef carries `workspaceId`, `scope`, `kind:"todo"` and string `id`.

### Get the current baseline

Obtain a current baseline before an update recipe (reuse a sufficient native read), then run again afterward for readback; keep the returned `object`, `revision` and `snapshot`:

```sh
current=$(mind todo get --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"target":$TODO_TARGET}
JSON
)
printf '%s\n' "$current"
TODO_TARGET=$(printf '%s\n' "$current" | jq -ce 'select(.ok == true) | .data.object')
TODO_REVISION=$(printf '%s\n' "$current" | jq -er 'select(.ok == true) | .data.revision')
```

Continue only if the call succeeded and the extracted target/revision is valid. `expectedRevision` is the parent's current revision for both parent and child changes; never assume it starts at 1 or advances by one.

### Complete the parent

```sh
mind todo update --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"requestId":"delivery-complete-001","input":{"target":$TODO_TARGET,"expectedRevision":$TODO_REVISION,"changes":[{"change":"status","status":"finished"}]}}
JSON
```

Read back parent status. Children keep their own status. To reopen, use `unfinished` with a freshly read baseline and a new mutation ID.

### Add a Subtask

Resolve `$SUBTASK_DATE` as local today in the user's timezone; it is independent of any requested deadline:

```sh
mind todo update --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json <<JSON
{"requestId":"delivery-child-add-001","input":{"target":$TODO_TARGET,"expectedRevision":$TODO_REVISION,"changes":[{"change":"child_create","content":"Review the draft","progressDate":"$SUBTASK_DATE","dueDate":null}]}}
JSON
```

Read back and retain the new child's actual `snapshot.children[].id`. Creating a Todo with children uses the same child fields in its `children` array, without `change`.

### Update / complete a Subtask

After a fresh `todo.get`, set `$CHILD_ID` to the selected returned numeric child ID. This constructs a complete `child_update` from its current fields, changes status to finished, and sends JSON via stdin:

```sh
printf '%s\n' "$current" | jq -ce --argjson childId "$CHILD_ID" '
  select(.ok == true) | .data as $todo |
  $todo.snapshot.children[] | select(.id == $childId) |
  {requestId:"delivery-child-update-001",input:{target:$todo.object,
    expectedRevision:$todo.revision,changes:[{change:"child_update",childId:.id,
    content:.content,progressDate:.progressDate,dueDate:.dueDate,status:"finished"}]}}
' | mind todo update --input-file - --workspace "$WORKSPACE" --connection "$CONNECTION" --json
```

To edit content/deadline instead, replace only those values in the constructed child mutation and preserve its current status. Setting `dueDate:null` explicitly clears the deadline. Parent deadline changes use `{"change":"deadline","dueDate":null}` to clear, or an explicit date to set. Finish with the [receipt and readback criteria](../SKILL.md#5-verify-and-report); use the [recovery process](../SKILL.md#recover-from-the-actual-outcome) for failures or uncertain outcomes.
