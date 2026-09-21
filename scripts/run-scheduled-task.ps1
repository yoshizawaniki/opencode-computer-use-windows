# Shared launcher invoked by opencode-computer-use scheduled tasks
# (registered via scheduled_task_register). One generic script, not one
# generated per task — the prompt/model are looked up by TaskId from the
# files scheduled_task_register wrote under artifacts/tasks/.
#
# The prompt is read via Get-Content (never embedded in a command line the
# way schtasks/cmd would need re-quoting), then passed to `opencode run` as
# a single PowerShell argument — no shell re-splitting risk regardless of
# quotes/newlines in the prompt text.
param([Parameter(Mandatory = $true)][string]$TaskId)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$tasksDir = Join-Path $root "artifacts\tasks"
$promptFile = Join-Path $tasksDir "$TaskId.prompt.txt"
$metaFile = Join-Path $tasksDir "$TaskId.meta.json"
$statusFile = Join-Path $tasksDir "$TaskId.status.json"
$debugLogFile = Join-Path $tasksDir "$TaskId.debug.log"
$debugRawLog = $env:OPENCODE_CU_SCHEDULE_DEBUG_LOG -eq "1"

$prompt = Get-Content $promptFile -Raw
$meta = Get-Content $metaFile -Raw | ConvertFrom-Json

$startedAt = (Get-Date).ToUniversalTime().ToString("o")
@{ taskId = $TaskId; state = "running"; startedAt = $startedAt; finishedAt = $null; exitCode = $null } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $statusFile -Encoding UTF8

try {
    if ($debugRawLog) {
        # Windows PowerShell 5.1's *>> writes UTF-16LE by default, which makes
        # cross-tool inspection inconsistent. Merge stderr into stdout and
        # explicitly persist raw debug output as UTF-8 instead.
        & opencode run $prompt -m $meta.model --print-logs 2>&1 |
            Out-File -LiteralPath $debugLogFile -Append -Encoding utf8
    } else {
        & opencode run $prompt -m $meta.model *> $null
    }
    $exit = $LASTEXITCODE
    @{ taskId = $TaskId; state = $(if ($exit -eq 0) { "finished" } else { "failed" }); startedAt = $startedAt; finishedAt = (Get-Date).ToUniversalTime().ToString("o"); exitCode = $exit } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $statusFile -Encoding UTF8
    exit $exit
} catch {
    @{ taskId = $TaskId; state = "failed"; startedAt = $startedAt; finishedAt = (Get-Date).ToUniversalTime().ToString("o"); exitCode = 1; errorType = $_.Exception.GetType().FullName } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $statusFile -Encoding UTF8
    exit 1
}
