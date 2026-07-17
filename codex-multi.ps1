$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:DefaultAccounts = @('zxc', 'aiasio')
$script:RevokeOverrideVariable = 'CODEX_REVOKE_TOKEN_URL_OVERRIDE'
$script:GuiLocalLogoutEndpoint = 'http://127.0.0.1:9/oauth/revoke'
$script:IsWindowsPlatform = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
    [System.Runtime.InteropServices.OSPlatform]::Windows
)
$script:HomeRoot = if ($env:CODEX_MULTI_HOME) {
    [System.IO.Path]::GetFullPath($env:CODEX_MULTI_HOME)
} else {
    Join-Path $HOME '.codex-accounts'
}

function Show-Usage {
    @'
Codex multi-account launcher

Usage:
  .\codex-multi.ps1 init [account ...]
  .\codex-multi.ps1 login <account>
  .\codex-multi.ps1 logout <account>
  .\codex-multi.ps1 status [account]
  .\codex-multi.ps1 gui-switch-protection <status|enable|disable>
  .\codex-multi.ps1 list
  .\codex-multi.ps1 path <account>
  .\codex-multi.ps1 doctor
  .\codex-multi.ps1 run <account> [codex arguments ...]
  .\codex-multi.ps1 remote-start <account>
  .\codex-multi.ps1 remote-status <account>
  .\codex-multi.ps1 remote-stop <account>
  .\codex-multi.ps1 remote-pair <account>
  .\codex-multi.ps1 hub-install
  .\codex-multi.ps1 hub-start
  .\codex-multi.ps1 hub-status
  .\codex-multi.ps1 hub-reload
  .\codex-multi.ps1 hub-stop
  .\codex-multi.ps1 hub-open
  .\codex-multi.ps1 <account> [codex arguments ...]

Examples:
  .\codex-multi.ps1 init
  .\codex-multi.ps1 login zxc
  .\codex-multi.ps1 login aiasio
  .\codex-multi.ps1 zxc
  .\codex-multi.ps1 aiasio exec "summarize this repository"

Set CODEX_MULTI_HOME to override the default account root:
  $env:CODEX_MULTI_HOME = 'D:\codex-accounts'
'@
}

function Assert-AccountName([string] $Name) {
    if ([string]::IsNullOrWhiteSpace($Name) -or
        $Name -in @('.', '..') -or
        $Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
        throw "Invalid account name '$Name'. Use 1-64 letters, digits, dots, underscores, or hyphens."
    }
}

function Get-AccountHome([string] $Name) {
    Assert-AccountName $Name
    return Join-Path $script:HomeRoot $Name
}

function Initialize-Account([string] $Name) {
    $homePath = Get-AccountHome $Name
    if (-not (Test-Path -LiteralPath $homePath -PathType Container)) {
        $null = New-Item -ItemType Directory -Path $homePath -Force
        Write-Host "Created $Name at $homePath"
    }
    return $homePath
}

function Get-CodexCommand {
    $requested = if ($env:CODEX_MULTI_CODEX_COMMAND) {
        $env:CODEX_MULTI_CODEX_COMMAND
    } else {
        'codex'
    }

    $command = Get-Command $requested -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $command) {
        throw "Codex CLI was not found. Install it, or set CODEX_MULTI_CODEX_COMMAND to its path."
    }
    return $command.Source
}

function Invoke-ForAccount {
    param(
        [Parameter(Mandatory)] [string] $Account,
        [Parameter(Mandatory)] [object[]] $CodexArguments
    )

    $homePath = Initialize-Account $Account
    $codexCommand = Get-CodexCommand
    $oldCodexHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')
    $oldRevokeOverride = [Environment]::GetEnvironmentVariable($script:RevokeOverrideVariable, 'Process')

    try {
        [Environment]::SetEnvironmentVariable('CODEX_HOME', $homePath, 'Process')
        # GUI switch protection is intentionally scoped away from the two
        # independent account homes. Their explicit login/logout operations
        # retain normal server-side refresh-token revocation semantics.
        [Environment]::SetEnvironmentVariable($script:RevokeOverrideVariable, $null, 'Process')
        & $codexCommand @CodexArguments
        $script:LastInvocationExitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    } finally {
        [Environment]::SetEnvironmentVariable($script:RevokeOverrideVariable, $oldRevokeOverride, 'Process')
        [Environment]::SetEnvironmentVariable('CODEX_HOME', $oldCodexHome, 'Process')
    }
}

function Set-GuiSwitchProtection([string] $Mode) {
    if (-not $script:IsWindowsPlatform) {
        throw 'GUI switch protection is only available for the Windows Codex app.'
    }

    $current = [Environment]::GetEnvironmentVariable($script:RevokeOverrideVariable, 'User')
    switch ($Mode.ToLowerInvariant()) {
        'status' {
            $enabled = $current -eq $script:GuiLocalLogoutEndpoint
            Write-Output "GUI switch protection: $(if ($enabled) { 'enabled' } else { 'disabled' })"
            if ($current -and -not $enabled) {
                Write-Output "A different user-level $($script:RevokeOverrideVariable) value is configured."
            }
        }
        'enable' {
            if ($current -and $current -ne $script:GuiLocalLogoutEndpoint) {
                throw "Refusing to replace an existing user-level $($script:RevokeOverrideVariable) value."
            }
            [Environment]::SetEnvironmentVariable(
                $script:RevokeOverrideVariable,
                $script:GuiLocalLogoutEndpoint,
                'User'
            )
            Write-Output 'GUI switch protection enabled for future Windows sessions.'
            Write-Warning 'GUI logout will remove its local credentials without revoking the server-side refresh token. Use disable before a security-sensitive logout.'
            Write-Output 'This takes effect after the next Windows sign-in or reboot; it does not alter the currently running Codex app.'
        }
        'disable' {
            if ($current -eq $script:GuiLocalLogoutEndpoint) {
                [Environment]::SetEnvironmentVariable($script:RevokeOverrideVariable, $null, 'User')
            } elseif ($current) {
                throw "Refusing to remove a different user-level $($script:RevokeOverrideVariable) value."
            }
            Write-Output 'GUI switch protection disabled for future Windows sessions.'
            Write-Output 'This takes effect after the next Windows sign-in or reboot.'
        }
        default { throw "Unknown GUI switch protection mode '$Mode'. Use status, enable, or disable." }
    }
}

function Require-Account([object[]] $Values, [string] $Action) {
    if ($Values.Count -lt 1) {
        throw "'$Action' requires an account name."
    }
    Assert-AccountName ([string] $Values[0])
    return [string] $Values[0]
}

function Get-Accounts {
    if (-not (Test-Path -LiteralPath $script:HomeRoot -PathType Container)) {
        return @()
    }
    return @(Get-ChildItem -LiteralPath $script:HomeRoot -Directory |
        Sort-Object Name |
        ForEach-Object { $_.Name })
}

function Test-RemotePairCommand {
    $codexCommand = Get-CodexCommand
    $helpText = (& $codexCommand remote-control --help 2>&1 | Out-String)
    return $helpText -match '(?m)^\s+pair\s+'
}

$rawArguments = @($args)
if ($rawArguments.Count -eq 0) {
    Show-Usage
    exit 0
}

$action = ([string] $rawArguments[0]).ToLowerInvariant()
[object[]] $rest = @()
if ($rawArguments.Count -gt 1) {
    $rest = @($rawArguments[1..($rawArguments.Count - 1)])
}
$exitCode = 0

try {
    switch ($action) {
        'help' { Show-Usage }
        '--help' { Show-Usage }
        '-h' { Show-Usage }

        'init' {
            $accounts = if ($rest.Count -gt 0) { $rest } else { $script:DefaultAccounts }
            foreach ($account in $accounts) { $null = Initialize-Account ([string] $account) }
        }

        'list' {
            $accounts = @(Get-Accounts)
            if ($accounts.Count -eq 0) {
                Write-Host "No accounts initialized under $script:HomeRoot"
            } else {
                foreach ($account in $accounts) {
                    Write-Output "$account`t$(Get-AccountHome $account)"
                }
            }
        }

        'path' {
            $account = Require-Account $rest $action
            Write-Output (Get-AccountHome $account)
        }

        'login' {
            $account = Require-Account $rest $action
            Invoke-ForAccount $account @('login', '--device-auth')
            $exitCode = $script:LastInvocationExitCode
        }

        'logout' {
            $account = Require-Account $rest $action
            Invoke-ForAccount $account @('logout')
            $exitCode = $script:LastInvocationExitCode
        }

        'status' {
            [object[]] $accounts = @()
            if ($rest.Count -gt 0) {
                $accounts = @([string] $rest[0])
            } else {
                $accounts = @(Get-Accounts)
            }
            if ($accounts.Count -eq 0) {
                Write-Host 'No accounts initialized. Run: .\codex-multi.ps1 init'
            }
            foreach ($account in $accounts) {
                Write-Host "[$account]"
                Invoke-ForAccount $account @('login', 'status')
                $statusCode = $script:LastInvocationExitCode
                if ($statusCode -ne 0) { $exitCode = $statusCode }
            }
        }

        'gui-switch-protection' {
            if ($rest.Count -ne 1) {
                throw "'gui-switch-protection' requires status, enable, or disable."
            }
            Set-GuiSwitchProtection ([string] $rest[0])
        }

        'doctor' {
            $codexCommand = Get-CodexCommand
            Write-Output "CLI:          $(& $codexCommand --version)"
            Write-Output "Executable:   $codexCommand"
            Write-Output "Account root: $script:HomeRoot"
            Write-Output "Platform:     $([System.Runtime.InteropServices.RuntimeInformation]::OSDescription)"
            if ($script:IsWindowsPlatform) {
                Write-Output 'Remote host:  Windows loopback-WebSocket workaround available'
            } else {
                Write-Output 'Remote host:  Unix host detected'
            }
            Write-Output "Pair command: $(if (Test-RemotePairCommand) { 'available' } else { 'not available in this CLI version' })"
            $guiProtection = [Environment]::GetEnvironmentVariable($script:RevokeOverrideVariable, 'User') -eq $script:GuiLocalLogoutEndpoint
            Write-Output "GUI protection: $(if ($guiProtection) { 'enabled' } else { 'disabled' })"
        }

        'run' {
            $account = Require-Account $rest $action
            $forwarded = if ($rest.Count -gt 1) { @($rest[1..($rest.Count - 1)]) } else { @() }
            Invoke-ForAccount $account $forwarded
            $exitCode = $script:LastInvocationExitCode
        }

        'remote-start' {
            $account = Require-Account $rest $action
            if ($script:IsWindowsPlatform) {
                & (Join-Path $PSScriptRoot 'codex-remote-windows.ps1') start $account
                $exitCode = $LASTEXITCODE
            } else {
                Invoke-ForAccount $account @('remote-control', 'start', '--json')
                $exitCode = $script:LastInvocationExitCode
            }
        }

        'remote-status' {
            $account = Require-Account $rest $action
            if ($script:IsWindowsPlatform) {
                & (Join-Path $PSScriptRoot 'codex-remote-windows.ps1') status $account
                $exitCode = $LASTEXITCODE
            } else {
                Write-Output 'The Unix CLI reports status when remote-control starts; no separate status subcommand is exposed.'
            }
        }

        'remote-stop' {
            $account = Require-Account $rest $action
            if ($script:IsWindowsPlatform) {
                & (Join-Path $PSScriptRoot 'codex-remote-windows.ps1') stop $account
                $exitCode = $LASTEXITCODE
            } else {
                Invoke-ForAccount $account @('remote-control', 'stop', '--json')
                $exitCode = $script:LastInvocationExitCode
            }
        }

        'remote-pair' {
            $account = Require-Account $rest $action
            if (-not (Test-RemotePairCommand)) {
                throw "This Codex CLI does not provide 'remote-control pair'. Update Codex and retry."
            }
            if ($script:IsWindowsPlatform) {
                & (Join-Path $PSScriptRoot 'codex-remote-windows.ps1') pair $account
                $exitCode = $LASTEXITCODE
            } else {
                Invoke-ForAccount $account @('remote-control', 'pair')
                $exitCode = $script:LastInvocationExitCode
            }
        }

        'hub-install' {
            & (Join-Path $PSScriptRoot 'install-hub.ps1')
            $exitCode = if ($?) { 0 } else { 1 }
        }

        'hub-start' {
            & (Join-Path $PSScriptRoot 'hub.ps1') start
            $exitCode = if ($?) { 0 } else { 1 }
        }

        'hub-status' {
            & (Join-Path $PSScriptRoot 'hub.ps1') status
            $exitCode = if ($?) { 0 } else { 1 }
        }

        'hub-reload' {
            & (Join-Path $PSScriptRoot 'hub.ps1') reload
            $exitCode = if ($?) { 0 } else { 1 }
        }

        'hub-stop' {
            & (Join-Path $PSScriptRoot 'hub.ps1') stop
            $exitCode = if ($?) { 0 } else { 1 }
        }

        'hub-open' {
            & (Join-Path $PSScriptRoot 'hub.ps1') open
            $exitCode = if ($?) { 0 } else { 1 }
        }

        default {
            Assert-AccountName $action
            Invoke-ForAccount $action $rest
            $exitCode = $script:LastInvocationExitCode
        }
    }
} catch {
    Write-Error $_.Exception.Message
    $exitCode = 1
}

exit $exitCode
