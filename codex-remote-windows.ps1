$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:HomeRoot = if ($env:CODEX_MULTI_HOME) {
    [System.IO.Path]::GetFullPath($env:CODEX_MULTI_HOME)
} else {
    Join-Path $HOME '.codex-accounts'
}
$script:ReceiveTimeoutSeconds = 45
$script:RevokeOverrideVariable = 'CODEX_REVOKE_TOKEN_URL_OVERRIDE'

function Show-Usage {
    @'
Native Windows Codex remote-control host

Usage:
  .\codex-remote-windows.ps1 start <account>
  .\codex-remote-windows.ps1 status <account>
  .\codex-remote-windows.ps1 pair <account>
  .\codex-remote-windows.ps1 stop <account>

Use account name "default" for the normal ~/.codex home.
'@
}

function Assert-AccountName([string] $Name) {
    if ([string]::IsNullOrWhiteSpace($Name) -or
        $Name -in @('.', '..') -or
        $Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw "Invalid account name '$Name'."
    }
}

function Get-AccountHome([string] $Account) {
    Assert-AccountName $Account
    if ($Account -eq 'default') {
        return Join-Path $HOME '.codex'
    }
    return Join-Path $script:HomeRoot $Account
}

function Get-StatePath([string] $Account) {
    return Join-Path (Get-AccountHome $Account) 'remote-windows.json'
}

function Get-State([string] $Account) {
    $statePath = Get-StatePath $Account
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        return $null
    }
    return Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
}

function Save-State([string] $Account, [int] $ProcessId, [int] $Port) {
    $statePath = Get-StatePath $Account
    [pscustomobject]@{
        processId = $ProcessId
        port = $Port
        startedAt = [DateTimeOffset]::UtcNow.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Remove-State([string] $Account) {
    $statePath = Get-StatePath $Account
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        Remove-Item -LiteralPath $statePath -Force
    }
}

function Get-NativeCodexExe {
    if ($env:CODEX_MULTI_NATIVE_CODEX_EXE) {
        $candidate = [System.IO.Path]::GetFullPath($env:CODEX_MULTI_NATIVE_CODEX_EXE)
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        throw "CODEX_MULTI_NATIVE_CODEX_EXE does not exist: $candidate"
    }

    $npmRoot = (& npm root --global 2>$null | Select-Object -First 1)
    if ($npmRoot) {
        $candidate = Join-Path $npmRoot '@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }

    throw 'Could not find the npm-installed native codex.exe. Reinstall @openai/codex or set CODEX_MULTI_NATIVE_CODEX_EXE.'
}

function Get-FreeLoopbackPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([System.Net.IPEndPoint] $listener.LocalEndpoint).Port
    } finally {
        $listener.Stop()
    }
}

function Send-WebSocketJson {
    param(
        [Parameter(Mandatory)] [System.Net.WebSockets.ClientWebSocket] $Socket,
        [Parameter(Mandatory)] [object] $Value
    )
    $json = $Value | ConvertTo-Json -Depth 30 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $segment = [System.ArraySegment[byte]]::new($bytes)
    $null = $Socket.SendAsync(
        $segment,
        [System.Net.WebSockets.WebSocketMessageType]::Text,
        $true,
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()
}

function Receive-WebSocketJson {
    param([Parameter(Mandatory)] [System.Net.WebSockets.ClientWebSocket] $Socket)

    $buffer = New-Object byte[] 65536
    $stream = [System.IO.MemoryStream]::new()
    $timeout = [System.Threading.CancellationTokenSource]::new(
        [TimeSpan]::FromSeconds($script:ReceiveTimeoutSeconds)
    )
    try {
        do {
            $segment = [System.ArraySegment[byte]]::new($buffer)
            $result = $Socket.ReceiveAsync($segment, $timeout.Token).GetAwaiter().GetResult()
            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                throw 'The app-server closed the WebSocket connection.'
            }
            $stream.Write($buffer, 0, $result.Count)
        } until ($result.EndOfMessage)

        $json = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
        return $json | ConvertFrom-Json
    } finally {
        $timeout.Dispose()
        $stream.Dispose()
    }
}

function Wait-RpcResponse {
    param(
        [Parameter(Mandatory)] [System.Net.WebSockets.ClientWebSocket] $Socket,
        [Parameter(Mandatory)] [int] $Id
    )
    while ($true) {
        $message = Receive-WebSocketJson $Socket
        $idProperty = $message.PSObject.Properties['id']
        if ($idProperty -and [int] $idProperty.Value -eq $Id) {
            $errorProperty = $message.PSObject.Properties['error']
            if ($errorProperty -and $null -ne $errorProperty.Value) {
                $errorJson = $errorProperty.Value | ConvertTo-Json -Depth 20 -Compress
                throw "App-server RPC failed: $errorJson"
            }
            return $message.result
        }
    }
}

function Invoke-RemoteRpc {
    param(
        [Parameter(Mandatory)] [int] $Port,
        [Parameter(Mandatory)] [string] $Method,
        [Parameter(Mandatory)] [object] $Params
    )

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    try {
        $null = $socket.ConnectAsync(
            [Uri] "ws://127.0.0.1:$Port",
            [System.Threading.CancellationToken]::None
        ).GetAwaiter().GetResult()

        Send-WebSocketJson $socket ([ordered]@{
            method = 'initialize'
            id = 1
            params = [ordered]@{
                clientInfo = [ordered]@{
                    name = 'codex_multi_windows'
                    title = 'Codex Multi Account Windows Remote Host'
                    version = '1.0.0'
                }
                capabilities = [ordered]@{ experimentalApi = $true }
            }
        })
        $null = Wait-RpcResponse $socket 1
        Send-WebSocketJson $socket ([ordered]@{ method = 'initialized'; params = @{} })

        Send-WebSocketJson $socket ([ordered]@{
            method = $Method
            id = 2
            params = $Params
        })
        return Wait-RpcResponse $socket 2
    } finally {
        if ($socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
            try {
                $null = $socket.CloseAsync(
                    [System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure,
                    'done',
                    [System.Threading.CancellationToken]::None
                ).GetAwaiter().GetResult()
            } catch {
                # The local process may already be exiting.
            }
        }
        $socket.Dispose()
    }
}

function Get-RunningState([string] $Account) {
    $state = Get-State $Account
    if ($null -eq $state) { return $null }
    $process = Get-Process -Id ([int] $state.processId) -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        Remove-State $Account
        return $null
    }
    return $state
}

function Wait-AppServerReady([int] $Port, [System.Diagnostics.Process] $Process) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "App-server exited early with code $($Process.ExitCode)."
        }
        try {
            $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/readyz" -TimeoutSec 1
            if ($response.StatusCode -eq 200) { return }
        } catch {
            Start-Sleep -Milliseconds 150
        }
    }
    throw 'Timed out waiting for the local app-server readiness endpoint.'
}

function Wait-RemoteConnected([int] $Port, [object] $InitialStatus) {
    $status = $InitialStatus
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ($status.status -eq 'connecting' -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 400
        $status = Invoke-RemoteRpc $Port 'remoteControl/status/read' @{}
    }
    if ($status.status -in @('errored', 'disabled')) {
        throw "Remote control entered status '$($status.status)' for server '$($status.serverName)'."
    }
    return $status
}

function Start-RemoteHost([string] $Account) {
    $homePath = Get-AccountHome $Account
    if (-not (Test-Path -LiteralPath $homePath -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $homePath -Force
    }

    $existing = Get-RunningState $Account
    if ($null -ne $existing) {
        $status = Invoke-RemoteRpc ([int] $existing.port) 'remoteControl/status/read' @{}
        if ($status.status -notin @('errored', 'disabled')) {
            $status | ConvertTo-Json -Depth 10
            return
        }
        Stop-RemoteHost $Account
    }

    $codexExe = Get-NativeCodexExe
    $port = Get-FreeLoopbackPort
    $stdoutPath = Join-Path $homePath 'remote-windows.stdout.log'
    $stderrPath = Join-Path $homePath 'remote-windows.stderr.log'
    $oldCodexHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
    $oldRevokeOverride = [Environment]::GetEnvironmentVariable($script:RevokeOverrideVariable, 'Process')
    try {
        [Environment]::SetEnvironmentVariable('CODEX_HOME', $homePath, 'Process')
        # A user-level GUI switch-protection override must never leak into the
        # independently authenticated account app-servers.
        [Environment]::SetEnvironmentVariable($script:RevokeOverrideVariable, $null, 'Process')
        $process = Start-Process -FilePath $codexExe `
            -ArgumentList @('app-server', '--listen', "ws://127.0.0.1:$port") `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath `
            -PassThru
    } finally {
        [Environment]::SetEnvironmentVariable($script:RevokeOverrideVariable, $oldRevokeOverride, 'Process')
        [Environment]::SetEnvironmentVariable('CODEX_HOME', $oldCodexHome, 'Process')
    }

    try {
        Wait-AppServerReady $port $process
        $status = Invoke-RemoteRpc $port 'remoteControl/enable' @{ ephemeral = $true }
        $status = Wait-RemoteConnected $port $status
        Save-State $Account $process.Id $port
        $status | ConvertTo-Json -Depth 10
    } catch {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
        $details = if (Test-Path -LiteralPath $stderrPath) {
            (Get-Content -Tail 30 -LiteralPath $stderrPath) -join [Environment]::NewLine
        } else { '' }
        if ($details) { throw "$($_.Exception.Message)`n$details" }
        throw
    }
}

function Invoke-Running([string] $Account, [string] $Method, [object] $Params) {
    $state = Get-RunningState $Account
    if ($null -eq $state) {
        throw "Remote host for '$Account' is not running."
    }
    return Invoke-RemoteRpc ([int] $state.port) $Method $Params
}

function Stop-RemoteHost([string] $Account) {
    $state = Get-RunningState $Account
    if ($null -eq $state) {
        Write-Output "Remote host for '$Account' is not running."
        return
    }
    try {
        $null = Invoke-RemoteRpc ([int] $state.port) 'remoteControl/disable' @{ ephemeral = $true }
    } catch {
        Write-Warning $_.Exception.Message
    }
    Stop-Process -Id ([int] $state.processId) -Force -ErrorAction SilentlyContinue
    Remove-State $Account
    Write-Output "Stopped remote host for '$Account'."
}

$rawArguments = @($args)
if ($rawArguments.Count -lt 1 -or ([string] $rawArguments[0]) -in @('help', '-h', '--help')) {
    Show-Usage
    exit 0
}
if ($rawArguments.Count -lt 2) {
    Write-Error "'$($rawArguments[0])' requires an account name."
    exit 1
}

$action = ([string] $rawArguments[0]).ToLowerInvariant()
$account = ([string] $rawArguments[1]).ToLowerInvariant()

try {
    Assert-AccountName $account
    switch ($action) {
        'start' { Start-RemoteHost $account }
        'status' {
            $status = Invoke-Running $account 'remoteControl/status/read' @{}
            $status | ConvertTo-Json -Depth 10
        }
        'pair' {
            $pairing = Invoke-Running $account 'remoteControl/pairing/start' @{ manualCode = $true }
            if (-not $pairing.manualPairingCode) {
                throw 'The remote-control service did not return a manual pairing code.'
            }
            Write-Output "Pairing code: $($pairing.manualPairingCode)"
            Write-Output "Expires at:   $([DateTimeOffset]::FromUnixTimeSeconds([long] $pairing.expiresAt).ToLocalTime())"
        }
        'stop' { Stop-RemoteHost $account }
        default { throw "Unknown action '$action'." }
    }
} catch {
    Write-Error $_.Exception.Message
    exit 1
}

exit 0
