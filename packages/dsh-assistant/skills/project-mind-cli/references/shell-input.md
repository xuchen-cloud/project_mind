# Shell input

Read this guide before adapting a Bash example to PowerShell or choosing how to send JSON. Keep the method's DTO unchanged; discover its exact fields with `mind schema METHOD --json`.

## Binding and paths

Reuse the runtime-supplied invocation for the **current shell**, including its executable path and Workspace/connection arguments. `$WORKSPACE` and `$CONNECTION` in these guides are variables populated from that binding, not automatically named environment variables. Object and receipt IDs come from authorized native results.

Quote every path according to the current shell, whether it contains Chinese, spaces, shell metacharacters or only ASCII. In PowerShell, invoke a quoted executable path with `&`; single-quoted literals preserve literal characters, while double-quoted strings expand variables. Keep the supplied Windows extended-path prefix `\\?\` intact. Reuse the supplied shell fragment directly; do not manually double backslashes as if shell text were JSON.

## PowerShell

PowerShell does not support Bash `<<JSON` here-doc syntax. Build the DTO as a PowerShell object and serialize it with `ConvertTo-Json -Depth 20`. Prefer a system temporary file written as UTF-8 without a BOM; this avoids dependence on native pipeline encoding and keeps transient JSON outside watched Project directories.

This complete read-only example retrieves a known Operation Receipt. First populate `$WORKSPACE` and `$CONNECTION` from the supplied binding and `$OPERATION_ID` from that connection's actual receipt result. `mind` is supplied on PATH; if using its absolute path, reuse the runtime's PowerShell invocation. Run this as a shell script: its final `exit` returns the CLI exit code.

```powershell
$ErrorActionPreference = 'Stop'
$json = @{ operationId = $OPERATION_ID } | ConvertTo-Json -Depth 20
$path = [IO.Path]::GetTempFileName()
try {
    [IO.File]::WriteAllText($path, $json, [Text.UTF8Encoding]::new($false))
    mind operation get --input-file $path --workspace $WORKSPACE --connection $CONNECTION --json
    $mindExitCode = $LASTEXITCODE
} finally {
    [IO.File]::Delete($path)
}
exit $mindExitCode
```

The CLI's JSON stdout passes through unchanged, including error responses; the exit code is saved before cleanup. Inspect both the process result and JSON `ok` / `error` using the [recovery rules](writes.md#recover-from-the-actual-outcome). Serialization, file-write and cleanup failures remain errors. For another method, replace only the DTO and command; `record.patch` uses `--patch-file $path` for its native RecordPatch payload. For dependent calls, retain each response and exit code, proceed only after success, and exit with the relevant failure code rather than overwriting it with a later call.

### Text pipelines and encoding

PowerShell pipelines can work: PowerShell 7 sending correct UTF-8 JSON text without a BOM to `mind ... --input-file -` preserves non-ASCII content. Windows PowerShell 5.1 or a custom `$OutputEncoding` can change the bytes sent to a native process. ASCII encoding can replace characters with `?` while leaving valid but corrupted JSON; UTF-8 with a BOM or UTF-16 input can be rejected. The temporary-file recipe above writes the required bytes independently of `$OutputEncoding`. `Set-Content -Encoding utf8` has version-dependent BOM behavior; use the explicit .NET encoding above for this recipe.

## Bash

Examples marked `bash` use Bash variable expansion, here-docs, command substitution and, where shown, `jq`. They are not PowerShell scripts. `--input-file -` reads JSON from stdin (up to 2 MiB); `--patch-file -` accepts native RecordPatch JSON. A quoted here-doc delimiter such as `<<'JSON'` preserves literal text; the unquoted `<<JSON` in examples expands variables. Build JSON with a serializer when values need JSON escaping, rather than interpolating arbitrary text into those templates.

See the [known receipt example](writes.md#recover-from-the-actual-outcome) for a Bash here-doc read using the supplied binding and an actual receipt ID.
