# setup-terminal-key.ps1
# 確保每個 terminal 視窗都有唯一識別碼（WT_SESSION / PIC_TERM_KEY）
# 適用於非 Windows Terminal 環境（VS Code terminal、standalone PowerShell 等）

$snippet = @'

# pic-agent-call: terminal identity key
# 若在 VS Code 整合終端機下，強制每次生成新 UUID 以防繼承互蓋；非 VS Code 則在不存在時補上
if ($env:TERM_PROGRAM -eq "vscode") {
    $env:WT_SESSION = [System.Guid]::NewGuid().ToString()
    $env:PIC_TERM_KEY = $env:WT_SESSION
} else {
    if (-not $env:WT_SESSION) {
        $env:WT_SESSION = [System.Guid]::NewGuid().ToString()
    }
    if (-not $env:PIC_TERM_KEY) {
        $env:PIC_TERM_KEY = $env:WT_SESSION
    }
}
'@

$profilePath = $PROFILE
if (-not (Test-Path $profilePath)) {
    New-Item -ItemType File -Force $profilePath | Out-Null
    Write-Host "Created profile: $profilePath"
}

$content = Get-Content $profilePath -Raw
if ($content -match 'pic-agent-call: terminal identity key') {
    # 已經安裝過，進行取代更新（比對從註解開始到空行或檔尾的區塊）
    $content = $content -replace '(?s)# pic-agent-call: terminal identity key.*?(?=\r?\n\r?\n|\z)', $snippet.Trim()
    Set-Content -Path $profilePath -Value $content -Encoding utf8
    Write-Host "Updated existing terminal identity key setup in profile."
} else {
    # 全新安裝
    Add-Content -Path $profilePath -Value $snippet -Encoding utf8
    Write-Host "Installed terminal identity key setup in profile."
}

Write-Host "Done. Restart terminal to take effect."
Write-Host "Profile: $profilePath"
