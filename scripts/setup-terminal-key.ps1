# setup-terminal-key.ps1
# 確保每個 terminal 視窗都有唯一識別碼（WT_SESSION）
# 適用於非 Windows Terminal 環境（VS Code terminal、standalone PowerShell 等）

$snippet = @'

# pic-agent-call: terminal identity key
# 非 Windows Terminal 環境自動補 WT_SESSION，確保 statusline 與 agent 登記正常運作
if (-not $env:WT_SESSION) {
    $env:WT_SESSION = [System.Guid]::NewGuid().ToString()
}
'@

if (-not (Test-Path $PROFILE)) {
    New-Item -ItemType File -Force $PROFILE | Out-Null
    Write-Host "Created profile: $PROFILE"
}

if ((Get-Content $PROFILE -Raw) -match 'pic-agent-call: terminal identity key') {
    Write-Host "Already installed. No changes made."
    exit 0
}

Add-Content -Path $PROFILE -Value $snippet
Write-Host "Done. Restart terminal to take effect."
Write-Host "Profile: $PROFILE"
