$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:HubUrl = 'http://127.0.0.1:47831'
$script:HubHome = Join-Path $PSScriptRoot '.hub'
$script:StatePath = Join-Path $script:HubHome 'service.json'
$script:PasswordPath = Join-Path $script:HubHome 'public-password.txt'
$script:StdoutPath = Join-Path $script:HubHome 'supervisor.stdout.log'
$script:StderrPath = Join-Path $script:HubHome 'supervisor.stderr.log'
$script:HostAutomationPath = Join-Path $PSScriptRoot 'host-automation.ps1'

function Test-Hub {
    try {
        $health = Invoke-RestMethod -Uri "$script:HubUrl/health" -TimeoutSec 2
        return [bool] $health.ok
    } catch { return $false }
}

function Get-HubState {
    if (-not (Test-Path -LiteralPath $script:StatePath -PathType Leaf)) { return $null }
    return Get-Content -LiteralPath $script:StatePath -Raw | ConvertFrom-Json
}

function Get-HubProcess([object] $state) {
    if (-not $state -or -not $state.processId) { return $null }
    $process = Get-Process -Id ([int] $state.processId) -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $command = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction Stop
    if ($command.Name -notin @('node.exe', 'node') -or $command.CommandLine -notmatch 'src[\\/]supervisor\.mjs|src[\\/]server\.mjs') {
        throw "PID $($process.Id) is not a Codex Multi Node hub; refusing to control it."
    }
    return $process
}

function New-ControlToken {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
}

function Start-Hub {
    if (Test-Hub) { Write-Output "Hub is already running at $script:HubUrl"; return }
    $null = New-Item -ItemType Directory -Path $script:HubHome -Force
    $node = Get-Command node -ErrorAction Stop | Select-Object -First 1
    $supervisor = Join-Path $PSScriptRoot 'src\supervisor.mjs'
    $token = New-ControlToken
    $previousToken = $env:CODEX_HUB_CONTROL_TOKEN
    $previousPassword = $env:CODEX_HUB_PASSWORD
    try {
        $env:CODEX_HUB_CONTROL_TOKEN = $token
        if (-not $env:CODEX_HUB_PASSWORD) {
            if (-not (Test-Path -LiteralPath $script:PasswordPath -PathType Leaf)) {
                (New-ControlToken).Substring(0, 24) | Set-Content -LiteralPath $script:PasswordPath -Encoding ascii
            }
            $env:CODEX_HUB_PASSWORD = (Get-Content -LiteralPath $script:PasswordPath -Raw).Trim()
        }
        $process = Start-Process -FilePath $node.Source `
            -ArgumentList @($supervisor) `
            -WorkingDirectory $PSScriptRoot `
            -RedirectStandardOutput $script:StdoutPath `
            -RedirectStandardError $script:StderrPath `
            -WindowStyle Hidden `
            -PassThru
    } finally {
        $env:CODEX_HUB_CONTROL_TOKEN = $previousToken
        $env:CODEX_HUB_PASSWORD = $previousPassword
    }
    @{
        processId = $process.Id
        startedAt = (Get-Date).ToString('o')
        url = $script:HubUrl
        server = $supervisor
        controlToken = $token
        mode = 'blue-green'
    } | ConvertTo-Json | Set-Content -LiteralPath $script:StatePath -Encoding utf8

    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if (Test-Hub) { Write-Output "Hub supervisor started at $script:HubUrl (PID $($process.Id))"; return }
        if ($process.HasExited) {
            $details = if (Test-Path -LiteralPath $script:StderrPath) { Get-Content -LiteralPath $script:StderrPath -Raw } else { 'No error log was written.' }
            throw "Hub exited during startup. $details"
        }
        Start-Sleep -Milliseconds 250
    }
    throw "Hub did not become healthy. See $script:StderrPath"
}

function Stop-Hub {
    $state = Get-HubState
    if (-not $state) {
        if (Test-Hub) { throw 'Hub is running, but its service state file is missing; refusing to stop an unidentified process.' }
        Write-Output 'Hub is not running.'
        return
    }
    $process = Get-HubProcess $state
    $hasControlToken = $state.PSObject.Properties.Name -contains 'controlToken'
    if ($process -and $hasControlToken -and $state.controlToken) {
        try {
            Invoke-RestMethod -Method Post -Uri "$script:HubUrl/_supervisor/shutdown" -Headers @{ 'X-Hub-Control-Token' = $state.controlToken } -TimeoutSec 5 | Out-Null
        } catch { }
        try { $process.WaitForExit(8000) | Out-Null } catch { }
    }
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id; $process.WaitForExit(3000) | Out-Null }
    Remove-Item -LiteralPath $script:StatePath -Force
    Write-Output 'Hub stopped.'
}

function Reload-Hub {
    $state = Get-HubState
    if (-not $state -or -not ($state.PSObject.Properties.Name -contains 'controlToken') -or -not $state.controlToken) { throw 'This hub predates blue/green reload support. Run .\hub.ps1 restart once to migrate it.' }
    $result = Invoke-RestMethod -Method Post -Uri "$script:HubUrl/_supervisor/reload" -Headers @{ 'X-Hub-Control-Token' = $state.controlToken } -TimeoutSec 90
    Write-Output "Hub reloaded: $($result.activeSlot) active, generation $($result.generation)."
}

$action = if ($args.Count) { ([string] $args[0]).ToLowerInvariant() } else { 'status' }
switch ($action) {
    'start' { Start-Hub; if (Test-Path -LiteralPath $script:HostAutomationPath) { & $script:HostAutomationPath start } }
    'stop' { if (Test-Path -LiteralPath $script:HostAutomationPath) { & $script:HostAutomationPath stop }; Stop-Hub }
    'restart' { if (Test-Path -LiteralPath $script:HostAutomationPath) { & $script:HostAutomationPath stop }; Stop-Hub; Start-Hub; if (Test-Path -LiteralPath $script:HostAutomationPath) { & $script:HostAutomationPath start } }
    'reload' { Reload-Hub }
    'status' {
        if (Test-Hub) {
            $health = Invoke-RestMethod -Uri "$script:HubUrl/health" -TimeoutSec 2
            $service = try { Invoke-RestMethod -Uri "$script:HubUrl/api/service" -TimeoutSec 2 } catch { $null }
            Write-Output "Hub: online at $script:HubUrl"
            if ($service) { Write-Output "Service: $($service.mode), $($service.activeSlot) active, generation $($service.generation)" }
            foreach ($name in @('zxc', 'aiasio')) {
                $instance = $health.instances.$name
                Write-Output ("{0}: {1}{2}" -f $name, $(if ($instance.connected) { 'connected' } else { 'offline' }), $(if ($instance.error) { " - $($instance.error)" } else { '' }))
            }
            if (Test-Path -LiteralPath $script:HostAutomationPath) { & $script:HostAutomationPath status }
        } else { Write-Output 'Hub: offline'; exit 1 }
    }
    'open' { Start-Hub; Start-Process $script:HubUrl }
    default { throw 'Usage: .\hub.ps1 start|stop|restart|reload|status|open' }
}
