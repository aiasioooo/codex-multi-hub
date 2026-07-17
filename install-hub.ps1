$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$accountRoot = if ($env:CODEX_MULTI_HOME) {
    [System.IO.Path]::GetFullPath($env:CODEX_MULTI_HOME)
} else {
    Join-Path $HOME '.codex-accounts'
}
$mcpName = 'codex_multi_hub'
$mcpEntry = Join-Path $PSScriptRoot 'src\mcp.mjs'
$skillSource = Join-Path $PSScriptRoot 'skill\codex-hub'
$oldCodexHome = [Environment]::GetEnvironmentVariable('CODEX_HOME', 'Process')

Push-Location $PSScriptRoot
try {
    npm install --omit=dev
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

    foreach ($account in @('zxc', 'aiasio')) {
        $accountHomePath = Join-Path $accountRoot $account
        if (-not (Test-Path -LiteralPath $accountHomePath -PathType Container)) {
            throw "Account home does not exist: $accountHomePath"
        }

        $skillTarget = Join-Path $accountHomePath 'skills\codex-hub'
        $null = New-Item -ItemType Directory -Path $skillTarget -Force
        Copy-Item -Path (Join-Path $skillSource '*') -Destination $skillTarget -Recurse -Force

        [Environment]::SetEnvironmentVariable('CODEX_HOME', $accountHomePath, 'Process')
        $serverJson = codex mcp list --json | Out-String
        $servers = if ([string]::IsNullOrWhiteSpace($serverJson)) { @() } else { @($serverJson | ConvertFrom-Json) }
        if ($servers | Where-Object { $null -ne $_ -and $_.PSObject.Properties['name'] -and $_.name -eq $mcpName }) {
            codex mcp remove $mcpName
            if ($LASTEXITCODE -ne 0) { throw "Could not replace MCP configuration for $account" }
        }
        codex mcp add $mcpName --env "HUB_INSTANCE=$account" -- node $mcpEntry
        if ($LASTEXITCODE -ne 0) { throw "Could not install MCP configuration for $account" }
        Write-Output "Installed hub tools and coordination skill for $account"
    }

    # The desktop account is a neutral coordinator, not a third operator. Its
    # MCP identity can route work to zxc/aiasio but cannot impersonate either.
    $guiHome = Join-Path $HOME '.codex'
    $guiSkillTarget = Join-Path $guiHome 'skills\codex-hub'
    $null = New-Item -ItemType Directory -Path $guiSkillTarget -Force
    Copy-Item -Path (Join-Path $skillSource '*') -Destination $guiSkillTarget -Recurse -Force

    [Environment]::SetEnvironmentVariable('CODEX_HOME', $guiHome, 'Process')
    $serverJson = codex mcp list --json | Out-String
    $servers = if ([string]::IsNullOrWhiteSpace($serverJson)) { @() } else { @($serverJson | ConvertFrom-Json) }
    if ($servers | Where-Object { $null -ne $_ -and $_.PSObject.Properties['name'] -and $_.name -eq $mcpName }) {
        codex mcp remove $mcpName
        if ($LASTEXITCODE -ne 0) { throw 'Could not replace MCP configuration for the desktop GUI coordinator' }
    }
    codex mcp add $mcpName --env 'HUB_INSTANCE=gui' -- node $mcpEntry
    if ($LASTEXITCODE -ne 0) { throw 'Could not install MCP configuration for the desktop GUI coordinator' }
    Write-Output 'Installed neutral hub coordination tools and skill for the desktop GUI account'
} finally {
    [Environment]::SetEnvironmentVariable('CODEX_HOME', $oldCodexHome, 'Process')
    Pop-Location
}

$hubScript = Join-Path $PSScriptRoot 'hub.ps1'
try {
    & $hubScript reload
} catch {
    Write-Warning "Blue/green reload was unavailable; restarting only the hub supervisor: $($_.Exception.Message)"
    & $hubScript restart
}
if ($LASTEXITCODE -ne 0) { throw 'Hub failed to start' }

foreach ($account in @('zxc', 'aiasio')) {
    try {
        Invoke-RestMethod -Method Post `
            -Uri 'http://127.0.0.1:47831/api/tools/reload_mcp' `
            -Headers @{ 'X-Hub-Instance' = $account } `
            -ContentType 'application/json' `
            -Body (@{ instance = $account } | ConvertTo-Json) | Out-Null
    } catch {
        Write-Warning "The $account app server could not reload MCP immediately: $($_.Exception.Message)"
    }
}

Write-Output 'Installation complete. Open the observer with: .\codex-multi.ps1 hub-open'
