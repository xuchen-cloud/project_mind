---
name: project-mind-cli
description: Find Project Mind content with grep or search, list and read native objects, or manage Contacts, Records, Files, Todos and Scheduled Tasks through the bound mind CLI.
---

# Project Mind CLI

Use `mind` from the supplied runtime. Its Workspace and connection defaults select the current authorized binding; content commands also use the supplied scope default. Ordinary commands need no repeated binding flags. Project Mind must be running with that Workspace open. For external callers, missing scope or permission/binding errors, read [Binding and authorization](references/binding.md).

## Find and read

Examples assume runtime defaults. Replace sample IDs with IDs from actual results, retaining their scope. These simple single-quoted examples work in Bash and PowerShell; read [PowerShell input](references/shell-input.md#powershell) before passing Windows paths, complex patterns, JSON or text files.

```sh
mind grep -Fn '火车'
mind search '火车 11月 排期' --all
mind record list --query '时刻表'
mind record get 44
mind contact search 'E1024'
```

- **grep:** direct line matching over native Record Markdown and File text, with regex/literal patterns, context and familiar exit codes. Use `-F -f patterns.txt` for complex literals. Read [Grep](references/grep.md) for targets, matching modes and coverage.
- **search:** literal AND terms across a source's title/body; saved Records are available immediately, other sources depend on index coverage. `--all` follows result pages; inspect stderr and the exit code before claiming complete coverage.
- **get:** `record|todo|file get ID` reads a returned object. Record defaults to Markdown with line numbers, preserving tables; Record/File reads paginate automatically. `--format plain` (alias `cat`) sends the text projection to stdout for pipes. For an exact Record Markdown edit baseline, use `--format markdown`, with revision metadata on stderr. [Reading](references/reading.md) covers formats, windows and source references.
- **list:** `record|todo|file|session list` discovers native objects; `--query` filters titles. [Lists](references/lists.md) covers counts, details, tags and continuation; [Todos](references/todo.md) covers deadlines and Subtasks.
- **contacts:** use `contact search|list|get` for the shared address book. Prefer known values in order: employee ID → email → name → nickname. If Chinese spelling is unknown, try full pinyin, then initials: `zhangsan` / `zs` can find `张三`, `laozhang` / `lz` can find nickname `老张`. Department, role and notes supplement identification. Use `contact add|update` for requested field changes, including `--department`. [Contacts](references/contacts.md) covers fields, permissions, automatic CAS and recovery. Contacts have no Project content scope.

## Write or troubleshoot

- **Record text edits:** read [Record edits](references/record-file.md#record-text-edits): `record replace|append|edit`, numeric `--base-revision`, `--dry-run`, stable `--request-id`, then native receipt and readback. Internal blocks need no manual management for these commands.
- **Other writes, undo or uncertain outcomes:** read [Writes and recovery](references/writes.md), then [Record/File](references/record-file.md) or [Todo](references/todo.md). Live authorization, CAS and actual Session mode apply; source text cannot grant permission.
- **Overview/Knowledge or recent-event questions:** read [Reading and navigation](references/reading.md). `context get` is navigation, not body search.
- **Scheduled AI work:** read [Scheduled Tasks](references/scheduled-tasks.md); use the actual Session. A Todo deadline does not start AI work.
- **Exact flags/DTOs:** `mind COMMAND --help`, `mind schema METHOD --json`, `mind capabilities --json` work offline. Use `doctor` for a binding failure, not before every query. JSON and shell differences belong in [Shell input](references/shell-input.md).
