$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:HubHome = Join-Path $PSScriptRoot '.hub'
$script:ServicePath = Join-Path $script:HubHome 'host-automation-service.json'
$script:StatePath = Join-Path $script:HubHome 'host-automation-state.json'
$script:StdoutPath = Join-Path $script:HubHome 'host-automation.stdout.log'
$script:StderrPath = Join-Path $script:HubHome 'host-automation.stderr.log'
$script:ProgramPath = Join-Path $PSScriptRoot 'src\host-automation.mjs'

function Get-AutomationState {
    if (-not (Test-Path -LiteralPath $script:ServicePath -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $script:ServicePath -Raw | ConvertFrom-Json
}

function Get-AutomationProcess([object] $state) {
    if (-not $state -or -not $state.processId) { return $null }
    $process = Get-Process -Id ([int] $state.processId) -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $command = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction Stop
    if ($command.Name -notin @('node.exe', 'node') -or $command.CommandLine -notmatch 'host-automation\.mjs') {
        throw "PID $($process.Id) is not the Nacchan host automation; refusing to control it."
    }
    return $process
}

function Start-Automation {
    $state = Get-AutomationState
    $existing = Get-AutomationProcess $state
    if ($existing) { Write-Output "Host automation is already running (PID $($existing.Id))."; return }

    $null = New-Item -ItemType Directory -Path $script:HubHome -Force
    $node = Get-Command node -ErrorAction Stop | Select-Object -First 1
    $process = Start-Process -FilePath $node.Source `
        -ArgumentList @($script:ProgramPath) `
        -WorkingDirectory $PSScriptRoot `
        -RedirectStandardOutput $script:StdoutPath `
        -RedirectStandardError $script:StderrPath `
        -WindowStyle Hidden `
        -PassThru

    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 125
        if ($process.HasExited) {
            $details = if (Test-Path -LiteralPath $script:StderrPath) { Get-Content -LiteralPath $script:StderrPath -Raw } else { 'No error log was written.' }
            throw "Host automation exited during startup. $details"
        }
        $started = Get-AutomationState
        if ($started -and $started.processId -eq $process.Id -and $started.status -eq 'running') {
            Write-Output "Host automation started (PID $($process.Id))."
            return
        }
    }
    throw "Host automation did not publish startup state. See $script:StderrPath"
}

function Stop-Automation {
    $state = Get-AutomationState
    $process = Get-AutomationProcess $state
    if (-not $process) { Write-Output 'Host automation is not running.'; return }
    Stop-Process -Id $process.Id
    try { $process.WaitForExit(3000) | Out-Null } catch { }
    Write-Output "Host automation stopped (PID $($process.Id))."
}

function Show-Status {
    $state = Get-AutomationState
    $process = Get-AutomationProcess $state
    if (-not $process) { Write-Output 'Host automation: offline'; return }
    Write-Output "Host automation: running (PID $($process.Id))"
    if (Test-Path -LiteralPath $script:StatePath -PathType Leaf) {
        $schedule = Get-Content -LiteralPath $script:StatePath -Raw | ConvertFrom-Json
        Write-Output "Next ambient wake: $($schedule.nextAmbientAt)"
        if ($schedule.lastWake) { Write-Output "Last wake: $($schedule.lastWake.kind) / $($schedule.lastWake.instance) at $($schedule.lastWake.at)" }
    }
}

$action = if ($args.Count) { ([string] $args[0]).ToLowerInvariant() } else { 'status' }
switch ($action) {
    'start' { Start-Automation }
    'stop' { Stop-Automation }
    'restart' { Stop-Automation; Start-Automation }
    'status' { Show-Status }
    'wake' {
        if ($args.Count -lt 2) { throw 'Usage: .\host-automation.ps1 wake zxc|aiasio [ambient|daily|weekly|manual]' }
        $instance = [string] $args[1]
        $kind = if ($args.Count -ge 3) { [string] $args[2] } else { 'manual' }
        & (Get-Command node -ErrorAction Stop | Select-Object -First 1).Source $script:ProgramPath --wake $instance $kind
        if ($LASTEXITCODE -ne 0) { throw "Manual host wake failed with exit code $LASTEXITCODE" }
    }
    default { throw 'Usage: .\host-automation.ps1 start|stop|restart|status|wake' }
}
