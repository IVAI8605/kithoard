$ErrorActionPreference = 'Stop'
Set-Location -Path (Split-Path -Parent $PSScriptRoot)

function Invoke-Step {
  param([string]$Name, [scriptblock]$Action)
  Write-Host ("[gate] {0} ... " -f $Name) -NoNewline
  # 原生命令的 stderr 在 PS 5.1 会被包成 ErrorRecord；临时放宽，改用退出码判定
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & $Action 2>&1 | Out-String
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  if ($code -ne 0) {
    Write-Host 'FAIL'
    ($output -split "`r?`n" | Select-Object -Last 30) | ForEach-Object { Write-Host $_ }
    exit 1
  }
  Write-Host 'PASS'
}

Invoke-Step 'typecheck:node' { & npx tsc --noEmit -p tsconfig.node.json }
Invoke-Step 'typecheck:web' { & npx tsc --noEmit -p tsconfig.web.json }
Invoke-Step 'lint' { & npm run lint }
Invoke-Step 'test' { & npm run test }
Invoke-Step 'build' { & npm run build }

Write-Host '[gate] changelog ... ' -NoNewline
$dash = [char]0x2014
$version = (Get-Content -Raw -Encoding UTF8 'package.json' | ConvertFrom-Json).version
$head = @(
  Get-Content -Encoding UTF8 'CHANGELOG.md' |
    Where-Object { $_.Trim().Length -gt 0 } |
    Select-Object -First 3
)
$pattern = '^##\s+' + [regex]::Escape($version) + '\s+' + $dash + '\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}$'
$found = $false
foreach ($line in $head) {
  if ($line -match $pattern) { $found = $true }
}
if (-not $found) {
  Write-Host 'FAIL'
  Write-Host ('version heading for {0} missing in the first 3 non-empty lines' -f $version)
  exit 1
}
Write-Host 'PASS'

Write-Host 'GATE PASS: 6/6'
