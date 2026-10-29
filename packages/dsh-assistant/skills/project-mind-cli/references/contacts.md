# Contacts and the shared address book

Use this branch to find a person, read their contact details, or save a requested contact change. Contacts belong to the Workspace's shared address book, independently of Project content. Use the current runtime binding; an external caller needs its supplied Workspace/connection binding and explicit contact permission. Read [PowerShell input](shell-input.md#powershell) for literal arguments and UTF-8 files.

## Find and read

```sh
mind contact search 'E1024'
mind contact search 'zhangsan@example.com'
mind contact search '张三'
mind contact search '老张'
mind contact search '张三 产品部'
mind contact list --limit 50 --offset 0
mind contact get 12
```

Use the strongest known value in this order: exact employee ID, email, name, nickname, full pinyin, then pronunciation initials. The examples are illustrative; use the user's actual known values. Department, role and notes provide additional context or literal query terms, as in `张三 产品部`. If the Chinese spelling is known, use it directly; try full pinyin when only the pronunciation is known, and initials last.

Use IDs from actual contact results when updating a person; a matching employee ID, email, name or other field is not a substitute for the returned native ID. Resolve ambiguous identity before writing. `mind search` and `mind grep` search content sources, not this address book.

`contact list` accepts an optional query; the `contact search` shorthand requires one. Both accept `--limit` from 1 through 200 (default 50), and a zero-based `--offset` (default 0). Their JSON result contains `items`, `totalCount`, `hasMore` and a continuation `nextOffset` when applicable. Continue with that offset and the same query/limit. This is offset pagination, not a pinned content-source cursor; concurrent address-book edits can shift results. A returned page is not the entire address book while `hasMore` is true.

Queries are case-insensitive literal text across name, nicknames, email, employee ID, role, department, notes and the generated full/abbreviated pinyin of the name and each nickname. Whitespace-separated words use AND; each word can match any searchable field. Thus two words can match different fields of the same contact. `%`, `_`, backslashes and regex characters have no wildcard meaning. Use one quoted query argument; use `--query` or `--` when a query begins with a dash.

Results rank by field first: employee ID → email → name → nickname → full pinyin → initials → department/role/notes (one final tier). Within the same field tier, exact matches precede prefixes, then substrings. Multiword matching remains cross-field AND; ranking uses the strongest matching field among those terms.

If you know the nickname is `老张`, search for `老张`. If you only know its pronunciation and are unsure of the Chinese spelling, full pinyin or initials can find that saved nickname too:

| Query | Matching saved nickname |
| --- | --- |
| `mind contact search '老张'` | `老张`, using the known spelling. |
| `mind contact search 'laozhang'` | `老张`, using its full pronunciation. |
| `mind contact search 'lz'` | `老张`, using pronunciation initials. |

The same applies to names: `zhangsan` / `zs` can find `张三` when you know only its pronunciation. Pinyin is generated automatically, with no setup during creation. Initials or other short queries may return several people; use the result's details to establish identity.

## Create or change specified fields

```sh
mind contact add --name '张三' --nicknames '老张;三哥' --email 'zhangsan@example.com' --notes-file notes.txt
mind contact update 12 --department '产品部'
```

`contact create` is an alias for `contact add`. Creation requires a nonempty name. Update takes a native contact ID and changes supplied fields, preserving omitted contact details; generated pinyin follows the name/nickname changes described below. Nicknames are one string containing semicolon-separated labels, such as `'老张;三哥'`; ASCII `;` and Chinese `；` separators are accepted and saved with `;`. Updating that field supplies its new whole value, not an append instruction. Chinese text is supported. `--notes` supplies literal notes; `--notes-file` reads UTF-8 notes, including multiline text, outside shell argument quoting. Choose one notes input.

Department is searchable and writable. The update above changes only `department`; name, nicknames, email, employee ID, role, notes and pinyin are preserved. Search by department alone to find candidates, or add it to known identity text to narrow the query.

Field flags are `--name`, `--nicknames`, `--email`, `--employee-id`, `--role`, `--department`, `--pinyin-full`, `--pinyin-abbr` and `--notes` / `--notes-file`. Get/update accept either a positional ID or `--id ID`.

Readable output is the default: list/search use tab-separated columns in order: ID, JSON-quoted name, email, employee ID, JSON-quoted nicknames, department (possibly empty). Nickname matches are therefore visible in the result; name/nickname quotes and embedded tabs/newlines are JSON-escaped. In email, employee ID and department, embedded tab, LF and CR appear as literal `\t`, `\n` and `\r`; other characters remain unchanged. Get/write show contact fields and notes, with revision/receipt metadata on stderr. Use `--json` for the unchanged native result. Contact plain/cat output uses this contact display, not a raw Record body; `--format markdown` is unsupported.

Project Mind automatically generates and persists full pinyin and abbreviations for names and multiple nicknames, using the same pronunciation rules in CLI and GUI. Creating a contact or changing its name/nicknames refreshes the corresponding search text. Changing only email or other unrelated details preserves it. Ordinary writes need no manually maintained pinyin:

```sh
mind contact update 12 --name '李四' --nicknames '老李;四哥'
```

Polyphonic characters follow the shared pronunciation rules; search does not enumerate every possible reading. Advanced callers can explicitly override the name's full pinyin and abbreviation with `--pinyin-full` / `--pinyin-abbr` (DTO `pinyinFull` / `pinyinAbbr`). These are optional overrides, not required setup for Chinese search; nickname pinyin remains automatically derived.

An empty string clears an optional field; name cannot be cleared. For example, `--email=` explicitly supplies an empty email, and `--notes=` clears notes. In PowerShell 5.1, prefer this attached form or an empty UTF-8 file for `--notes-file`, rather than relying on a separate `''` surviving legacy native argument passing. JSON fields must be strings when supplied; `null` is not a clearing instruction. Single-quote literal values, double an embedded single quote (`'O''Brien'`), and put complex/multiline notes in a UTF-8 file; the [PowerShell recipe](shell-input.md#powershell) controls its encoding. UTF-8 BOM is accepted; UTF-16 must be saved as UTF-8 rather than guessed or repaired.

## Revision and request identity

For an ordinary update, the CLI can fetch the current revision and apply CAS internally when `--base-revision` is omitted. `--request-id` is also optional and is generated for that invocation when absent. Neither convenience bypasses authorization or revision checks. A conflict requires rereading the contact and reconciling the intended fields with its current state.

For automation or a write whose identity must survive interruption, retain an explicit request ID and the exact payload. For an update, also retain the numeric revision from the preceding successful `contact get ID --json`:

```bash
mind contact update 12 --department '产品部' --base-revision "$CONTACT_REVISION" --request-id "$CONTACT_UPDATE_REQUEST_ID" --json
```

Both variables above are actual values retained for this task, not automatically injected environment names. Reusing the same request ID requires the identical method and payload, including the original `baseRevision`. Do not regenerate a baseline and replay an old request ID with the new value. A reconciled change is a new intended mutation and needs a new request ID.

A successful mutation returns `contact` with its fields and numeric `revision`, plus `operation` containing `requestId`, `operationId`, `method` and `undoAvailable:false`. Retain these and verify the requested fields with `contact get ID`. Contact receipts do not imply support in the Record/Todo/File `operation get` / `operation list` APIs. There is currently no contact undo command; an intentional correction is another guarded field update.

If a timeout or transport failure leaves the result uncertain, keep the exact request ID, fields and transmitted baseline. After attempting a mutation, the CLI's failure diagnostics print `Request ID:` and, for updates, the resolved `Base revision:` on stderr, including with JSON output. An automatic-revision update must recover using the revision actually sent, not a fresh auto-read; a second bare CLI invocation can generate a new request ID and baseline. Read the diagnostics, then resolve the outcome only by an identical replay with the original identity/payload or appropriate native readback. A matching current field value alone does not establish which request committed. Never blindly repeat an uncertain create with a new ID.

## Permission and exact DTOs

Reads require `contact.read`; writes require `contact.write`. These grants cover the shared address book and are separate from `source.read`, Project ownership and Workspace content grants. Built-in Project and Workspace conversations receive contact access, while a read-only Session still cannot mutate contacts. External connections need an explicit GUI contact setting: none, read or read/write. A content grant or a Project switch does not expand contact permission. Resolve denied access through the trusted user/runtime settings.

Contact calls use binding without a Project/Workspace content scope. Content-scope environment defaults are ignored; explicit `--project` / `--workspace-scope` flags are rejected. For exact flags use `mind contact COMMAND --help`; native DTOs use `mind schema contact.update --json` or the corresponding `contact.list`, `contact.search`, `contact.get` or `contact.create` method. List/search DTOs contain `{query?,limit?,offset?}`; get contains `{id}`. Create is `{requestId,fields:{...}}`; update is `{id,baseRevision,requestId,fields:{...}}`. `--input-file PATH` takes that exact DTO instead of shorthand fields, ID or pagination flags. Preserve native IDs and use only supplied string fields.
