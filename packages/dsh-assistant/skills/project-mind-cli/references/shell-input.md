# Shell input

Use this guide for Windows paths, special-character patterns, JSON or body files. `mind` receives arguments after the shell has parsed them; it does not repair shell quoting or decode another layer of backslash escapes. Obtain exact DTOs with `mind schema METHOD --json`.

## PowerShell

### Literal arguments and paths

Use ordinary single quotes for literal arguments. A single quote inside one is doubled: `'O''Brien'` passes `O'Brien`. Backslashes are literal in PowerShell strings; the escape character is the backtick. `$`, brackets, `&` and parentheses stay literal inside single quotes. Double-quoted strings expand variables and expressions.

```powershell
mind grep -Fn -e '火车 [A] $计划 & (11月)'
mind grep -Fn -e 'O''Brien'
```

Keep the supplied extended-length prefix `\\?\` and the absolute path after it unchanged. `\\?\D:\商店\BA项目` is one actual Windows path, not a question-mark directory. A JSON representation may display extra backslashes; decode JSON once with a JSON parser, then pass the resulting value. Do not paste its escaped representation as a shell path, double the real backslashes, strip the prefix or replace `?`.

The following illustrates an **external** binding; replace the executable/path/connection with the supplied values. The built-in runtime already supplies binding defaults and normally needs none of these flags:

```powershell
& 'C:\Program Files\Project Mind\mind.exe' record list --workspace '\\?\D:\Onebox\商店 [BA] & $资料' --connection 'CONNECTION_ID' --workspace-scope
```

Single quotes preserve PowerShell string contents, but native process argument passing is another boundary. Windows PowerShell 5.1 uses legacy native quoting; PowerShell 7.3+ provides `$PSNativeCommandArgumentPassing` (`Legacy`, `Standard`, `Windows`), with legacy handling still used for certain command/script types. Embedded double quotes and empty arguments can therefore behave differently. Prefer the supplied native executable and UTF-8 files for complex patterns/bodies; changing a quoting mode is not a general repair for arbitrary payloads. See Microsoft's [quoting rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules) and [native argument parsing](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing).

### Complex patterns and text bodies

PowerShell does not support Bash `<<JSON` here-docs. A single-quoted PowerShell here-string preserves literal content, including both quote characters; its opening marker is followed by a newline and its closing marker starts on a separate line. Write it with an explicit .NET encoding, then pass only the file path:

```powershell
$ErrorActionPreference = 'Stop'
$patternPath = [IO.Path]::GetTempFileName()
$patterns = @'
\\?\D:\商店\[a] $x.txt
He said "O'Brien" & (review)
'@
try {
    [IO.File]::WriteAllText($patternPath, $patterns, [Text.UTF8Encoding]::new($false))
    mind grep -F -n -f $patternPath
    $mindExitCode = $LASTEXITCODE
} finally {
    [IO.File]::Delete($patternPath)
}
exit $mindExitCode
```

This is literal matching: `-F` prevents regex interpretation, while `-f` moves pattern contents out of native argument quoting. A final line separator is fine; an intentional empty pattern line matches every line. Check the process exit code: grep's 1 means no selected line, 2 means error. Inspect stderr for incomplete coverage even when stdout contains matches. The final `exit` is for a standalone shell script; when chaining dependent steps, retain each exit code and stop on its actual failure instead of overwriting it.

Use the same `WriteAllText` approach for `--body-file`, `--old-text-file`, `--new-text-file` and `--before-file`; pass only paths on the command line. For an exact saved Markdown edit baseline, follow [PowerShell Markdown capture](powershell-baseline.md), which preserves trailing newlines and checks the native exit status before writing a usable baseline.

Windows PowerShell 5.1 `>` / `Out-File` default to UTF-16LE; PowerShell 7.4+ preserves the bytes when directly redirecting a native command's stdout. A text pipeline or merged stderr can change that behavior. See Microsoft's [encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding) and [redirection](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_redirection) references.

### JSON and encoding

Build the method DTO as an object, serialize with `ConvertTo-Json -Depth 20`, and use a UTF-8 temporary file outside managed Project directories. This example reads an existing receipt; `$OPERATION_ID` comes from a native write result:

```powershell
$ErrorActionPreference = 'Stop'
$json = @{ operationId = $OPERATION_ID } | ConvertTo-Json -Depth 20
$path = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))
    mind operation get --input-file $path --json
    $mindExitCode = $LASTEXITCODE
} finally {
    [IO.File]::Delete($path)
}
exit $mindExitCode
```

`--input-file -` accepts JSON stdin; a correct UTF-8 pipeline can work. Windows PowerShell 5.1 and custom `$OutputEncoding` can change native stdin bytes. ASCII replacement can turn Chinese into `?` while leaving valid JSON; the CLI cannot infer the lost characters. Use files with explicit UTF-8 encoding rather than assuming all PowerShell pipelines have the same behavior.

The CLI accepts UTF-8 with or without an initial BOM for JSON, body and grep pattern files. UTF-16 with a BOM receives a specific “save as UTF-8” error; raw NULs (possibly BOM-less UTF-16) and invalid UTF-8 are also rejected. It does not guess an encoding or restore damaged characters. `Set-Content -Encoding utf8` has version-dependent BOM behavior; the .NET recipe controls the bytes directly. A binary File upload uses its byte-oriented options, not a text-body option.

Read JSON stdout even when a mutation exits nonzero: inspect `ok/error` and [recover from the actual outcome](writes.md#recover-from-the-actual-outcome). Cleanup is not evidence that the native call succeeded. No Windows or PowerShell 5.1 end-to-end verification is claimed by these recipes.

## Bash

Examples marked `bash` use Bash expansion and here-docs; they are not PowerShell scripts. Prefer a JSON serializer when values require escaping. A quoted here-doc delimiter preserves literal bytes; an unquoted delimiter expands variables:

```bash
mind operation get --input-file - --json <<JSON
{"operationId":"$OPERATION_ID"}
JSON
```

`--input-file -` reads at most 2 MiB of JSON. `--patch-file -` reads the method's patch JSON. Keep the DTO unchanged when moving between shells, and use at most one stdin input per command. Runtime defaults apply in both shells; external binding belongs in [Binding and authorization](binding.md#external-binding).
