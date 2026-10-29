# Grep native content

`mind grep` reads authorized Record Markdown and registered File text directly through native paginated reads. It does not depend on search-index coverage. It still depends on File extraction support and live authorization. Use the runtime scope defaults or the [explicit binding](binding.md#external-binding).

```sh
mind grep -Fn '火车'
mind grep -Ein '火车|排期' --kind record
mind grep -Fn -e '11月' -e '排期' record:44 file:9
mind grep -F -f patterns.txt -n -C 2 record:44
mind grep -Fn -- '-literal-leading-dash'
```

Targets are `record:ID` or `file:ID` from native results, in the selected scope; they are not disk paths. Explicit targets are read directly. Without targets, grep first pages through the current kind's authorized inventory and stores its object references in a temporary file, then reads bodies. First matching output therefore waits for that kind's metadata pages; this stage neither loads bodies nor scans the disk. Body reads still check live authorization and revision consistency.

Workspace scope contains Workspace-owned objects, not all Projects. `--kind record|file` restricts the scan. A complete scan can cost more than indexed search; choose explicit known targets or `-l`/`-m` when they satisfy the task.

## Matching and output

| Option | Meaning |
| --- | --- |
| `-G` | Basic regex, the default; groups/counts use `\(` and `\{n,m\}`. |
| `-E` | Extended regex: groups, alternation, `+`, `?`, `{n,m}`. |
| `-F` | Literal strings; preferred for paths and other special-character text. |
| `-e PATTERN` | Add a pattern; repeated patterns combine with OR. |
| `-f FILE` | One pattern per UTF-8/UTF-8-BOM file line; repeatable. `-f -` reads stdin once. |
| `-i`, `-v`, `-x` | Unicode case-insensitive, inverted, or whole-line matching. |
| `-n` | 1-based line numbers; Record lines are Markdown lines. |
| `-l`, `-c`, `-q` | Matching object IDs, matching-line counts per object, or quiet early success. |
| `-m N` | Stop after N selected lines per object. |
| `-A N`, `-B N`, `-C N` | Following, preceding, or surrounding context. |
| `-h`, `-H` | Omit or include the object prefix. Here `-h` is grep's no-filename flag; help is `--help`. |

The default prefix is `record:ID:TEXT` or `file:ID:TEXT`; add `-n` for the line number. Short flags can be grouped (`-Fin`), values attached (`-m2`), and long values written as `--kind=record`. `--` ends option parsing. Empty pattern lines match every line; an empty pattern file matches no lines.

Regex supports Unicode and POSIX classes such as `[[:digit:]]`. Backreferences, lookaround, collating/equivalence classes, `\<`/`\>` word-edge escapes and `-P` are unsupported. `\d` means literal `d`; use `[[:digit:]]`. Check `mind grep --help` for the installed regex subset rather than assuming PCRE.

## Coverage, limits and exits

- **0:** at least one selected line; **1:** none; **2:** an error. With `-q`, the first match returns 0 even after an earlier source error, matching grep's quiet behavior.
- Each source read pins its revision. Changed, unreadable or incompletely extracted sources produce stderr diagnostics; earlier stdout can be partial. Office extraction is not assumed available.
- CRLF endings and a leading UTF-8 BOM are normalized for matching. Pattern text is not shell-expanded or backslash-unescaped by the CLI.
- Bounds include 2 MiB / 32768 patterns, 1 MiB per text line, at most 10000 context lines / 8 MiB context, and 65536 pages per read/inventory scan. Limit errors are explicit.
- `-q`, `-l`, `-m` and a downstream consumer stopping early intentionally bound the read. Do not describe such a run as an exhaustive content inventory.

## PowerShell patterns

For a simple literal, single quotes protect `$`, brackets and backslashes:

```powershell
mind grep -Fn -e '\\?\D:\商店\[a] $x.txt'
mind grep -Fn -e 'O''Brien'
```

For embedded quotes, multiple patterns, newlines or native argument-passing differences, put patterns in a UTF-8 file and use `mind grep -F -f patterns.txt`. The [PowerShell recipe](shell-input.md#powershell) writes exact UTF-8 bytes and explains 5.1 versus 7.3+ behavior. Use `-E -f` only when regex interpretation is intended. Preserve `\\?\` paths literally; a backslash in a regex and a backslash in a PowerShell string have different roles.
