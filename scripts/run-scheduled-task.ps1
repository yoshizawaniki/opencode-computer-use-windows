# Shared launcher invoked by every OpenCodeUpgrade-* scheduled task
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
$logFile = Join-Path $tasksDir "$TaskId.log"

$prompt = Get-Content $promptFile -Raw
$meta = Get-Content $metaFile -Raw | ConvertFrom-Json

"[$(Get-Date -Format o)] starting scheduled task '$TaskId'" | Out-File -FilePath $logFile -Append -Encoding utf8

try {
    & opencode run $prompt -m $meta.model --print-logs *>> $logFile
    "[$(Get-Date -Format o)] finished scheduled task '$TaskId' exit=$LASTEXITCODE" | Out-File -FilePath $logFile -Append -Encoding utf8
} catch {
    "[$(Get-Date -Format o)] scheduled task '$TaskId' FAILED: $($_.Exception.Message)" | Out-File -FilePath $logFile -Append -Encoding utf8
}
