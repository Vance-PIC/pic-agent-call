# setup-terminal-key.ps1
# 確保每個 terminal 視窗都有唯一識別碼（PIC_TERM_KEY + PIC_TERM_KEY_SCOPE）
# v1.3.0 金鑰隔離設計合約（SDD-Spec.md §8）：
#   - PIC_TERM_KEY_SCOPE 與當前 Shell 類型一致 → 沿用既有 PIC_TERM_KEY（防同分頁子行程重生）
#   - 不一致（如 VS Code 整合終端機繼承自 WT 啟動的 `code .`）→ 重新生成並更新 scope（防跨 Shell 類型污染）
#   - 徹底廢止對 WT_SESSION 環境變數的主動寫入

$snippet = @'

# pic-agent-call: terminal identity key (v1.3.0 scope isolation)
$__picCurrentScope = if ($env:TERM_PROGRAM -eq "vscode") { "vscode" } elseif ($env:WT_SESSION) { "windows-terminal" } else { "generic-shell" }
if ((-not $env:PIC_TERM_KEY) -or ($env:PIC_TERM_KEY_SCOPE -ne $__picCurrentScope)) {
    $env:PIC_TERM_KEY = [System.Guid]::NewGuid().ToString()
    $env:PIC_TERM_KEY_SCOPE = $__picCurrentScope
}
Remove-Variable -Name __picCurrentScope -ErrorAction SilentlyContinue
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
