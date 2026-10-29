# Capture an exact Markdown baseline in PowerShell

Use this branch before `record edit` when redirection or text pipelines could alter encoding or trailing newlines. The runtime must already supply its authorized binding/scope defaults. `$MIND_EXE` is the supplied absolute native executable; `$RECORD_ID` is an actual authorized result's ID. The executable path is passed directly, including any supplied Windows extended prefix.

This .NET capture avoids shell reconstruction of the content. It is written for APIs available to Windows PowerShell 5.1 and PowerShell 7; it is not a claim of Windows/5.1 end-to-end testing.

```powershell
$ErrorActionPreference = 'Stop'
$recordId = [long]$RECORD_ID
if ($recordId -le 0) { throw 'Use a native Record ID from an authorized result' }
$beforePath = [IO.Path]::GetTempFileName()
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $MIND_EXE
$start.Arguments = "record get $recordId --format markdown"
$start.UseShellExecute = $false
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false, $true)
$start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false, $true)
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $markdown = $stdoutTask.GetAwaiter().GetResult()
    $metadata = $stderrTask.GetAwaiter().GetResult()
    [Console]::Error.Write($metadata)
    if ($process.ExitCode -ne 0) { throw 'Markdown read failed; output may be partial' }
    [IO.File]::WriteAllText($beforePath, $markdown, [Text.UTF8Encoding]::new($false))
} catch {
    [IO.File]::Delete($beforePath)
    throw
} finally {
    $process.Dispose()
}
```

Retain the resulting `$beforePath` and the numeric **Head revision** from this successful read. Make an independent UTF-8 edited copy; pass the original file as `--before-file`, the edited copy as `--body-file`, and that head revision as `--base-revision`. Keep metadata out of the Markdown file. A failed/early-stopped read is not a baseline. Clean up both temporary files after preview, commit and readback are settled.

The edit converter normalizes CRLF to LF when checking the Markdown baseline; it does not discard extra trailing blank lines or repair changed content. Read a full fresh baseline after a conflict. Follow [Record edits](record-file.md#record-text-edits) and [write recovery](writes.md#recover-from-the-actual-outcome).
